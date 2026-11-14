#!/usr/bin/python3
"""Release lifecycle test on the dev host, as the unprivileged agent account.

Uploaded and driven by deploy/staging/run.mjs from the Mac. It reuses
companion-deploy itself (same deploy, preflight, unit, health and retention
code) with a staging Config/System: everything lives below
~/companion-staging, which acts as the service HOME. Units are renamed
companion-staging-*, the operator socket listens on 127.0.0.1:13082, and the
memory and QQ units are limited to Unix sockets, so no release (old ones have
3082/3001 hard-coded) can reach production ports. No sudo, no QQ login, no
model key, no provider call.

The scenarios in tools/scenarios.json are replayed against the upgraded release: a fake
OneBot (tools/fake-onebot.mjs) stands in for NapCat, and the release's own model gateway
runs with a scripted upstream (tools/fake-model.mjs).

Both directions are tested. After the upgrade has been smoked and has replayed the
scenarios, tools/migration-drill.mjs drills a schema migration on a copy of the
database (new release migrates behind a backup, old release still opens and writes it),
`companion-deploy rollback` returns to the from-release on the data root the new one
used, and a second rollback rolls forward again before the from-release is pruned.

  staging-agent.py lifecycle --from <tarball> --to <tarball>
  staging-agent.py scenarios [--only S1,S3]
  staging-agent.py reset
"""
import argparse
import http.client
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = Path.home() / 'companion-staging'
TOOLS, INBOX = ROOT / 'tools', ROOT / 'inbox'
UNITS_DIR = Path.home() / '.config/systemd/user'  # where the agent's user manager reads units
NODE_CACHE = Path.home() / '.cache/companion-staging'  # outside ROOT: survives --reset
PREFIX = 'companion-staging-'
OPERATOR_PORT, ONEBOT_PORT = 13082, 13001
INITIATION_POLL_MS = 3000  # scenario replay: how often the QQ bridge asks for an initiated run (production: 60 s)
PROD_PORTS = (3001, 3082, 6099)
UNIX_ONLY = ('memory', 'qq')  # their old code dials 127.0.0.1:3082 / :3001
PROXY = 'http://127.0.0.1:7890'
BASE = ROOT / '.local/share/companion-world-v1'
NODE = ROOT / '.local/opt/companion/bin/node'
JOURNAL_LINES = 15
SCENARIO = ROOT / 'scenario'  # fake OneBot control socket, model script and request log
FAKE_ONEBOT = 'companion-staging/tools/fake-onebot.mjs'


def load_companion_deploy(path=TOOLS / 'companion-deploy'):
    loader = importlib.machinery.SourceFileLoader('companion_deploy', str(path))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader('companion_deploy', loader))
    loader.exec_module(module)
    # Only staging units are ever listed, replaced or removed in the agent's unit directory.
    module.UNIT_PATTERN = re.compile(r'^' + PREFIX + r'[A-Za-z0-9-]+\.(service|socket)$')
    return module


def staging_unit(name, text, root=ROOT):
    """Production unit -> staging unit: renamed, HOME and paths below root, staging port, Unix-only workers."""
    if not name.startswith('companion-') or name.startswith(PREFIX):
        raise ValueError('unexpected unit name: ' + name)
    role = name[len('companion-'):].rsplit('.', 1)[0]
    text = re.sub(r'\bcompanion-([A-Za-z0-9-]+\.(?:service|socket))\b', lambda m: PREFIX + m.group(1), text)
    text = text.replace('%h/', str(root) + '/').replace('127.0.0.1:3082', '127.0.0.1:%d' % OPERATOR_PORT)
    extra = 'Environment=HOME=%s\n' % root
    if role in UNIX_ONLY:
        extra += 'RestrictAddressFamilies=AF_UNIX\n'
    if '[Service]\n' in text:
        text = text.replace('[Service]\n', '[Service]\n' + extra, 1)
    if '%h' in text or re.search(r'\b(%s)\b' % '|'.join(map(str, PROD_PORTS)), text):
        raise ValueError('unit still names the production home or a production port: ' + name)
    return PREFIX + name[len('companion-'):], text


def safe_root(root=ROOT, home=None):
    """The only directory --reset removes: exactly ~/companion-staging, a real directory owned by us."""
    home = Path(home or Path.home())
    if not home.is_absolute() or len(home.parts) < 3 or Path(root) != home / 'companion-staging' \
            or Path(root).is_symlink() or os.path.realpath(root) != str(root):
        raise SystemExit('refusing: staging root is not exactly <home>/companion-staging')
    if Path(root).exists() and Path(root).stat().st_uid != os.getuid():
        raise SystemExit('refusing: staging root is not owned by this user')
    return Path(root)


def build(cd):
    class StagingSystem(cd.System):
        def owner(self):
            return os.getuid(), os.getgid()

        def log_group(self):
            return os.getgid()

        def fchown(self, fd, uid, gid):
            pass

        def systemctl(self, *args, check=True):
            env = {**os.environ, 'XDG_RUNTIME_DIR': os.environ.get('XDG_RUNTIME_DIR', '/run/user/%d' % os.getuid())}
            result = subprocess.run(['systemctl', '--user', *args], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180, env=env)
            if check and result.returncode:
                raise cd.DeployError('systemctl %s failed: %s' % (' '.join(args), result.stderr.strip()[-400:]))
            return result

        def git(self, *args):
            # Staging tests unpublished commits; publication on origin main is companion-deploy's job in production.
            stdout = 'staging: origin main not checked\n-\n' if 'log' in args else ''
            return subprocess.CompletedProcess(args, 0, stdout, '')

        def confirm(self, prompt):
            self.say(prompt + 'y (staging)')
            return True

        def preflight(self, release):
            env = {'PATH': '/usr/bin:/bin', 'HOME': str(ROOT), 'LANG': 'C.UTF-8'}
            return subprocess.run([str(NODE), str(Path(release) / 'ops/preflight.mjs')], cwd=str(ROOT), env=env,
                                  stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=cd.PREFLIGHT_TIMEOUT_SECONDS)

        def say(self, text):
            for line in str(text).splitlines():
                print('  | ' + line, flush=True)

    class StagingDeployer(cd.Deployer):
        def prepare_dirs(self):
            for path in (self.config.state_dir, self.config.snapshots, self.config.work, self.config.releases, self.config.units):
                path.mkdir(mode=0o700, parents=True, exist_ok=True)

        def release_units(self, release_dir):
            target = self.config.state_dir / 'staging-units' / Path(release_dir).name
            if not target.is_dir():
                target.mkdir(mode=0o700, parents=True)
                for unit in sorted(cd.Deployer.release_units(release_dir).iterdir()):
                    name, text = staging_unit(unit.name, unit.read_text())
                    (target / name).write_text(text)
            return target

        def preflight(self, release_dir):
            if not (Path(release_dir) / 'ops/preflight.mjs').is_file():
                self.system.say('PREFLIGHT SKIPPED: %s has no ops/preflight.mjs (production companion-deploy refuses it)' % Path(release_dir).name)
                return []
            return super().preflight(release_dir)

    config = cd.Config(home=ROOT, state=ROOT / 'deploy-state', log=ROOT / 'deploy.log', status=ROOT / 'deploy.status.json',
                       user=os.environ.get('USER') or str(os.getuid()), ports=(OPERATOR_PORT,))
    config.units = UNITS_DIR
    return StagingDeployer(config, StagingSystem(config))


# ---------------------------------------------------------------- steps

def run(command, **kwargs):
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(ROOT), 'LANG': 'C.UTF-8', **kwargs.pop('env', {})}
    result = subprocess.run(command, cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=kwargs.pop('timeout', 300))
    if result.returncode:
        tail = (result.stderr or result.stdout).strip().splitlines()[-3:]
        raise RuntimeError('%s exited %d: %s' % (Path(command[1] if len(command) > 1 else command[0]).name, result.returncode, ' / '.join(tail)))
    return result.stdout


def install_runtime():
    cache = ROOT / '.cache/companion-deploy'
    cache.mkdir(parents=True, exist_ok=True)
    NODE_CACHE.mkdir(parents=True, exist_ok=True)
    for archive in NODE_CACHE.glob('node-v*-linux-*.tar.xz'):
        shutil.copyfile(archive, cache / archive.name)
    run(['/usr/bin/bash', str(TOOLS / 'install-runtime.sh')], env={'HTTPS_PROXY': PROXY, 'https_proxy': PROXY}, timeout=600)
    for archive in cache.glob('node-v*-linux-*.tar.xz'):
        if not (NODE_CACHE / archive.name).exists():
            shutil.copyfile(archive, NODE_CACHE / archive.name)
    return run([str(NODE), '--version']).strip()


def initialize(release):
    """The fresh-host steps from docs/DEV_WORKFLOW.md, run by the from-release itself."""
    ops = ROOT / 'src/companion' / release / 'ops'
    for script in ('bootstrap.mjs', 'prepare-memory.mjs', 'prepare-content.mjs'):
        run([str(NODE), str(ops / script)])
    run([str(NODE), str(ROOT / 'src/companion' / release / 'deploy/qq/prepare.mjs')])
    # Staging-only values (old releases ignore the port fields; their units are Unix-only anyway).
    # The memory worker ticks every 5 s here (production: 60 s) and retries 10 s after the spend tier refused it
    # (production: 30 min), so the consolidation scenarios do not wait minutes.
    edit('memory-worker.json', lambda c: c.update(operatorPort=OPERATOR_PORT, tickMs=5000, consolidationDeferMs=10000))
    edit('qq-bridge.json', lambda c: c.update(onebotPort=ONEBOT_PORT))
    origins = ['http://127.0.0.1:%d' % OPERATOR_PORT, 'http://localhost:%d' % OPERATOR_PORT]
    edit('authority.json', lambda c: c['operator'].update(origins=sorted(set(c['operator']['origins']) | set(origins))))
    return 'bootstrap, prepare-memory, prepare-content, qq prepare; staging ports set'


def edit(label, change):
    path = BASE / 'operator' / label
    config = json.loads(path.read_text())
    change(config)
    temporary = path.with_name('.' + label + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(json.dumps(config, indent=2) + '\n')
    os.replace(temporary, path)


def operator(method, route, body=None):
    token = (BASE / 'operator/console.token').read_text().strip()
    connection = http.client.HTTPConnection('127.0.0.1', OPERATOR_PORT, timeout=15)
    headers = {'authorization': 'Bearer ' + token}
    payload = None
    if body is not None:
        payload, headers['content-type'] = json.dumps(body), 'application/json'
    connection.request(method, route, body=payload, headers=headers)
    response = connection.getresponse()
    text = response.read().decode('utf8', 'replace')
    connection.close()
    try:
        value = json.loads(text)
    except ValueError:
        value = None
    if response.status != 200 or not isinstance(value, dict) or value.get('ok') is not True:
        code = (value or {}).get('error', {}).get('code') if isinstance(value, dict) else None
        raise RuntimeError('%s %s -> %d %s' % (method, route, response.status, code or ''))
    return value['value']


def unix_post(path, route, token=None):
    """HTTP POST over a Unix socket; returns the status code."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(15)
    client.connect(str(path))
    headers = 'POST %s HTTP/1.1\r\nHost: staging\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n' % route
    if token:
        headers += 'Authorization: Bearer %s\r\n' % token
    client.sendall((headers + '\r\n{}').encode())
    status = client.recv(64).decode('latin1').split(' ')
    client.close()
    return int(status[1])


def smoke():
    done = []
    world = operator('GET', '/world')
    assert 'world' in world and 'persona' in world, 'GET /world shape'
    done.append('GET /world paused=%s' % world['world'].get('paused'))
    runtime = operator('GET', '/runtime')
    done.append('GET /runtime speech=%s' % ((runtime.get('speech') or {}).get('status') if isinstance(runtime, dict) else '?'))
    qq = operator('GET', '/qq')
    done.append('GET /qq loggedIn=%s connected=%s' % (qq.get('loggedIn'), qq.get('connected')))
    operator('GET', '/memory')
    done.append('GET /memory')
    people = operator('GET', '/people')
    assert isinstance(people.get('people'), list) and people.get('limit') == 40, 'GET /people shape'
    conversations = operator('GET', '/conversations')
    assert isinstance(conversations, list), 'GET /conversations shape'
    done.append('GET /people admitted=%s; GET /conversations n=%d' % (people.get('admitted'), len(conversations)))
    spend = operator('GET', '/spend')
    assert spend.get('tier') in ('normal', 'reduced', 'restricted', 'exhausted') and 'capYuan' in spend, 'GET /spend shape'
    done.append('GET /spend day=%s spent=%s cap=%s tier=%s pricing=%s' % (spend.get('day'), spend.get('spentYuan'), spend.get('capYuan'), spend.get('tier'), spend.get('pricing')))
    name = world['persona']['value']['name']
    preview = operator('POST', '/persona/preview', {'patch': {'name': name}})
    done.append('POST /persona/preview' + (' chars=%s' % preview.get('chars') if isinstance(preview, dict) and 'chars' in preview else ''))
    operator('POST', '/persona', {'patch': {'name': name}, 'expectedRevision': world['persona']['revision']})
    after = operator('GET', '/world')['persona']['revision']
    done.append('POST /persona revision %s->%s' % (world['persona']['revision'], after))
    sock = BASE / 'ipc/conversation/execute.sock'
    caller = (BASE / 'conversation-config/caller.token').read_text().strip()
    unauthenticated, authenticated = unix_post(sock, '/execute'), unix_post(sock, '/execute', caller)
    if unauthenticated != 401 or not 400 <= authenticated < 500 or authenticated == 401:
        raise RuntimeError('conversation /execute answered %d without and %d with the caller token' % (unauthenticated, authenticated))
    done.append('conversation /execute 401 unauthenticated, %d with caller token (no model key: no turn run)' % authenticated)
    return '; '.join(done)


def scenario_unit(name, text, root=ROOT):
    """Staging unit -> scenario unit. The model unit starts the release's gateway through
    tools/fake-model.mjs (scripted upstream, no provider); the QQ unit may dial the fake OneBot
    on 127.0.0.1. Other units are unchanged. Idempotent."""
    if name == PREFIX + 'model.service' and '/tools/fake-model.mjs ' not in text:
        launcher = r'ExecStart=\1 %s/tools/fake-model.mjs --release %s/src/companion/current --config \2 --script %s/scenario/model-script.json --log %s/scenario/model-requests.jsonl' % ((root,) * 4)
        text, count = re.subn(r'^ExecStart=(\S+) \S+/model-gateway/main\.mjs --config (\S+)$', launcher, text, flags=re.M)
        if count != 1:
            raise ValueError('unexpected model gateway ExecStart')
    if name == PREFIX + 'qq.service':
        text = text.replace('RestrictAddressFamilies=AF_UNIX\n', '')
    return text


def reset_consolidation(database):
    """Deterministic reruns of the consolidation scenarios, while Authority is stopped: every private
    conversation starts the replay with nothing waiting (its cursor at its newest observation) and with
    today's batches unused. Digests and facts already written stay. Returns the number of conversations."""
    if not Path(database).exists():
        return 0
    db = sqlite3.connect(str(database))
    try:
        row = db.execute("SELECT value FROM metadata WHERE key='consolidation'").fetchone()
        if row is None:
            return 0
        state, count = json.loads(row[0]), 0
        for entity, own in state.items():
            own['calls'] = 0
            own.pop('deferredAt', None)
            streams = own.setdefault('streams', {})
            for capability, stream in db.execute("SELECT capability_id,stream_id FROM streams WHERE entity_id=? AND audience='private'", (entity,)).fetchall():
                entry = streams.setdefault(capability + '\0' + stream, {})
                newest = db.execute('SELECT id FROM observations WHERE capability_id=? AND stream_id=? ORDER BY rowid DESC LIMIT 1', (capability, stream)).fetchone()
                entry.update(calls=0, invalid=0)
                entry.pop('issued', None)
                if newest:
                    entry['lastObservationId'] = newest[0]
                count += 1
        db.execute("UPDATE metadata SET value=? WHERE key='consolidation'", (json.dumps(state),))
        db.execute("DELETE FROM maintenance_tasks WHERE mode='consolidation'")
        db.commit()
        return count
    finally:
        db.close()


def reset_initiations(database):
    """Deterministic reruns of the initiation scenarios, while Authority is stopped: no request of an earlier
    replay is still open (one that was out when its replay died would hold the next ones back for minutes) and
    the quiet hours are the default again. Returns whether there was anything to remove."""
    if not Path(database).exists():
        return False
    db = sqlite3.connect(str(database))
    try:
        removed = db.execute("DELETE FROM metadata WHERE key='initiations'").rowcount > 0
        db.commit()
        return removed
    finally:
        db.close()


def scenario_bridge_config(config, bridge_source):
    """qq-bridge.json for scenario replay: a release whose bridge fetches initiated runs asks every few seconds
    (production: every minute), so those scenarios do not wait minutes. Other releases are left alone. Idempotent."""
    if 'initiationPollMs' in bridge_source:
        config['initiationPollMs'] = INITIATION_POLL_MS
    return config


def scenario_content_config(config, content_source, replaying):
    """content.json while scenarios replay: staging has no image runtime, so a release that knows `allowRawSmallPng`
    lets the fake OneBot's small PNGs go to the scripted vision model as they are. Taken out again after the replay
    (`replaying` false): production never has it, and an older release refuses the key on a rollback. Idempotent."""
    if replaying and 'allowRawSmallPng' in content_source:
        config['allowRawSmallPng'] = True
    else:
        config.pop('allowRawSmallPng', None)
    return config


def stop_fake_onebot():
    subprocess.run(['pkill', '-U', str(os.getuid()), '-f', FAKE_ONEBOT], capture_output=True, timeout=20)


def scenarios(deployer, only=None):
    """Replay tools/scenarios.json against the current release; returns the summary line."""
    data = json.loads((TOOLS / 'scenarios.json').read_text())
    release = ROOT / 'src/companion/current'
    qq_config = json.loads((BASE / 'operator/qq-bridge.json').read_text())
    # The QQ unit loses its Unix-socket-only restriction below: it must dial the staging port, never NapCat's.
    bridge_source = (release / 'capabilities/qq/main.mjs').read_text()
    if qq_config.get('onebotPort') != ONEBOT_PORT or 'onebotPort' not in bridge_source:
        raise RuntimeError('this release cannot be pointed at the fake OneBot port %d' % ONEBOT_PORT)
    names = deployer.installed_units()
    stop_fake_onebot()
    deployer.stop_all(names)
    edit('qq-bridge.json', lambda c: scenario_bridge_config(c, bridge_source))
    content_source = (release / 'capabilities/media/main.mjs').read_text()
    edit('content.json', lambda c: scenario_content_config(c, content_source, True))
    for name in (PREFIX + 'model.service', PREFIX + 'qq.service'):
        path = deployer.config.units / name
        path.write_text(scenario_unit(name, path.read_text()))
    deployer.system.systemctl('daemon-reload')
    # Deterministic reruns: today's spend, the cap, the owner's once-a-day notice and consolidation start fresh,
    # and with the spend meter the day's vision/web counts, the usage ledger and its limits (not its history).
    model_data = Path(json.loads((BASE / 'operator/model-gateway.json').read_text())['settingsFile']).parent
    for label in ('spend.json', 'spend-settings.json', 'capability-usage.json', 'usage-ledger.json', 'usage-limits.json'):
        (model_data / label).unlink(missing_ok=True)
    # The mock provider's jobs of earlier replays go with the reservations they held (provider keys stay).
    (model_data / 'provider-jobs.json').unlink(missing_ok=True)
    reset_consolidation(BASE / 'authority-data/authority.sqlite')
    reset_initiations(BASE / 'authority-data/authority.sqlite')
    # Background jobs of an earlier replay go with the initiation records that kept them from being told twice.
    (BASE / 'media-data/jobs.json').unlink(missing_ok=True)
    dispatch = Path(qq_config['stateFile'])
    if dispatch.exists():
        state = json.loads(dispatch.read_text())
        if state.pop('budgetNotice', None) is not None:
            dispatch.write_text(json.dumps(state) + '\n')
    SCENARIO.mkdir(mode=0o700, exist_ok=True)
    (SCENARIO / 'model-script.json').write_text('[]\n')
    (SCENARIO / 'model-requests.jsonl').write_text('')
    control = SCENARIO / 'onebot.sock'
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(ROOT), 'LANG': 'C.UTF-8'}
    fake = subprocess.Popen([str(NODE), str(TOOLS / 'fake-onebot.mjs'), '--port', str(ONEBOT_PORT), '--token-file', str(BASE / 'qq-runtime/private/onebot.token'),
                             '--control', str(control), '--self', data['bot']['qq']], cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.time() + 15
        while not control.is_socket():
            if fake.poll() is not None or time.time() > deadline:
                raise RuntimeError('fake OneBot did not start: %s' % (fake.stderr.read().strip()[-200:] if fake.poll() is not None else 'timeout'))
            time.sleep(0.2)
        deployer.start_all(names)
        problems = deployer.health(names)
        if problems:
            raise RuntimeError('; '.join(problems))
        deployer.enable_all(names)
        command = [str(NODE), str(TOOLS / 'scenarios.mjs'), '--operator-port', str(OPERATOR_PORT), '--operator-token-file', str(BASE / 'operator/console.token'),
                   '--onebot-control', str(control), '--model-script', str(SCENARIO / 'model-script.json'), '--model-log', str(SCENARIO / 'model-requests.jsonl'),
                   '--scenarios', str(TOOLS / 'scenarios.json'),
                   '--inference-socket', str(BASE / 'ipc/model/inference.sock'), '--inference-token-file', str(BASE / 'service-config/inference.token')] + (['--only', only] if only else [])
        result = subprocess.run(command, cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=1800)
    finally:
        fake.terminate()
        try:
            fake.wait(timeout=10)
        except subprocess.TimeoutExpired:
            fake.kill()
        edit('content.json', lambda c: scenario_content_config(c, content_source, False))
    lines = (result.stdout + result.stderr).strip().splitlines()
    for line in lines:
        print('  | ' + line[:600], flush=True)
    summary = next((json.loads(line[len('SCENARIOS '):]) for line in lines if line.startswith('SCENARIOS {')), None)
    if summary is None:
        raise RuntimeError('scenario runner exited %d without a summary' % result.returncode)
    if result.returncode or summary['failed']:
        raise RuntimeError(summary['line'])
    return summary['line']


def usage_rows():
    """Today's usage ledger (operator GET /usage): the Beijing day and each capability's counted numbers."""
    usage = operator('GET', '/usage')
    return usage['day'], {row['id']: {key: row[key] for key in ('used', 'calls', 'ok', 'failed', 'denied', 'units', 'costYuan', 'busyMs')} for row in usage['rows']}


def usage_kept(before, now):
    """Nothing counted in `before` (one usage row) is missing from `now`; `now` may have counted more."""
    if not isinstance(now, dict):
        return False
    numbers = all(now.get(key, 0) >= before[key] for key in ('used', 'calls', 'ok', 'failed', 'costYuan', 'busyMs'))
    return numbers and all((now.get(part) or {}).get(name, 0) >= value for part in ('denied', 'units') for name, value in before[part].items())


def declared_rows():
    """The capabilities the running release keeps a usage row for; None when it has no usage ledger at all
    (such a release never touches the ledger files)."""
    try:
        return sorted(usage_rows()[1])
    except RuntimeError:
        return None


def ledger_survives(before, declared=None):
    """Q3 ledger-survives-rollback: `before` is usage_rows() under the new release, taken before the rollback.
    The old release has since started on this data root (rollback, smoke-from) and the new one again: the day's
    numbers must still be there. If the Beijing day changed meanwhile, that day must be a history line.
    `declared` (declared_rows() under the old release): a row of a capability the old release does not declare
    is not compared and is named in the result; that release cannot be made to keep it."""
    if not before:
        raise RuntimeError('no usage rows were noted before the rollback')
    day, rows = before
    unknown = sorted(name for name in rows if declared is not None and name not in declared)
    rows = {name: row for name, row in rows.items() if name not in unknown}
    if not any(row['calls'] for row in rows.values()):
        raise RuntimeError('the usage ledger was empty before the rollback: nothing to compare')
    today, now = usage_rows()
    if today != day:
        now = next((item['rows'] for item in operator('GET', '/usage/history?days=7')['days'] if item['day'] == day), {})
        rows = {name: row for name, row in rows.items() if row['used'] or row['calls'] or row['denied']}
    lost = sorted(name for name, row in rows.items() if not usage_kept(row, now.get(name)))
    if lost:
        raise RuntimeError('usage of %s lost across the rollback: %s' % (day, '; '.join('%s %s -> %s' % (name, rows[name], now.get(name)) for name in lost)[:500]))
    return 'day %s kept across rollback and roll-forward%s: calls %s%s' % (day, '' if today == day else ' (now a history line)', json.dumps({name: row['calls'] for name, row in rows.items() if row['calls']}, sort_keys=True),
                                                                           '; not compared, unknown to the from-release: %s' % ', '.join(unknown) if unknown else '')


def migration_drill(deployer, from_name, to_name):
    """tools/migration-drill.mjs on a COPY of the staging database, taken while the units are stopped."""
    live = BASE / 'authority-data/authority.sqlite'
    work = ROOT / 'drill'
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(mode=0o700)
    names = deployer.installed_units()
    deployer.stop_all(names)  # the Authority holds the writer lock while it runs; a file copy needs it gone
    try:
        shutil.copyfile(live, work / live.name)
        # With locking_mode=EXCLUSIVE the rollback journal stays on disk (header zeroed after a commit). It is
        # copied along: should it be hot, opening the copy rolls it back exactly as the next start would.
        journal = live.with_name(live.name + '-journal')
        if journal.exists():
            shutil.copyfile(journal, work / journal.name)
    finally:
        deployer.start_all(names)
    problems = deployer.health(names)
    if problems:
        raise RuntimeError('; '.join(problems))
    deployer.enable_all(names)
    releases = ROOT / 'src/companion'
    command = [str(NODE), str(TOOLS / 'migration-drill.mjs'), '--to', str(releases / to_name), '--from', str(releases / from_name), '--database', str(work / live.name)]
    result = subprocess.run(command, cwd=str(ROOT), env={'PATH': '/usr/bin:/bin', 'HOME': str(ROOT), 'LANG': 'C.UTF-8'},
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=300)
    line = next((line for line in result.stdout.splitlines() if line.startswith('DRILL ')), '')
    if result.returncode or not line.startswith('DRILL {'):
        raise RuntimeError(line or 'drill exited %d: %s' % (result.returncode, result.stderr.strip()[-300:]))
    if (BASE / 'authority-data/migration-backups').exists() and not json.loads(line[len('DRILL '):])['registered']:
        raise RuntimeError('the live database was backed up although the release registers no migration')
    return json.loads(line[len('DRILL '):])['line']


def prod_untouched():
    """Production listeners must still be there, and no staging process may own them."""
    out = subprocess.run(['ss', '-Hltnp'], capture_output=True, text=True, timeout=10).stdout
    mine = [line for line in out.splitlines() if re.search(r':(%s)\s' % '|'.join(map(str, PROD_PORTS)), line) and 'users:' in line]
    if mine:
        raise RuntimeError('a staging process listens on a production port')
    return 'no staging listener on %s' % ', '.join(map(str, PROD_PORTS))


def diagnostics(deployer):
    lines = []
    try:
        names = deployer.installed_units()
        for name, (state, restarts) in sorted(deployer.unit_states(names).items()):
            lines.append('  unit %-40s %-9s restarts=%s' % (name, state, restarts))
            if (state != 'active' and name.endswith('.service')) or restarts not in ('0', ''):
                journal = subprocess.run(['journalctl', '_UID=%d' % os.getuid(), '_SYSTEMD_USER_UNIT=' + name, '-n', str(JOURNAL_LINES), '--no-pager', '-o', 'cat'],
                                         capture_output=True, text=True, timeout=20).stdout.strip().splitlines()
                lines += ['    ' + line[:200] for line in journal[-JOURNAL_LINES:]]
    except Exception as error:  # diagnostics never hide the original failure
        lines.append('  diagnostics unavailable: %s' % error.__class__.__name__)
    return lines


def lifecycle(from_tarball, to_tarball):
    cd = load_companion_deploy()
    deployer = build(cd)
    from_name, to_name = (Path(t).name[:-len('.tar.gz')] for t in (from_tarball, to_tarball))
    results, started = [], time.time()

    def step(name, action, always=False):
        if not always and any(ok is not True for _n, ok, _d in results):
            results.append((name, None, 'skipped'))
            return None
        print('== %s' % name, flush=True)
        try:
            detail = action()
            results.append((name, True, detail or ''))
            return detail
        except (Exception, SystemExit) as error:
            results.append((name, False, '%s: %s' % (error.__class__.__name__, str(error)[:600])))
            return None

    def clean():
        extra = sorted(p.name for p in ROOT.iterdir() if p.name not in ('tools', 'inbox'))
        if extra or [p for p in UNITS_DIR.glob(PREFIX + '*')] or [p for p in UNITS_DIR.glob('*.wants/' + PREFIX + '*')]:
            raise RuntimeError('staging is not clean (%s); run with --reset' % (', '.join(extra[:5]) or 'leftover units'))
        return 'fresh %s' % ROOT

    def restart():
        names = deployer.installed_units()
        deployer.stop_all(names)
        deployer.start_all(names)
        problems = deployer.health(names)
        if problems:
            raise RuntimeError('; '.join(problems))
        deployer.enable_all(names)
        return '%d units healthy after restart' % len(names)

    def enabled(names):
        result = deployer.system.systemctl('is-enabled', *names, check=False)
        return dict(zip(names, result.stdout.split()))

    def legacy():
        """Production as the old companion-deploy left it: units running but not enabled."""
        names = deployer.startable(deployer.installed_units())
        deployer.system.systemctl('disable', *names)
        states = enabled(names)
        if any(state == 'enabled' for state in states.values()) or len(states) != len(names):
            raise RuntimeError('could not disable: %s' % states)
        return '%d running units disabled' % len(names)

    def manager_restart():
        """Proxy for `systemctl restart user@<uid>` / reboot: stop every unit without touching enablement,
        reload unit files and .wants links from disk, require that default.target's dependency tree reaches
        every unit, then start default.target and the [Install] targets and check health.

        A fresh manager starts default.target with every target inactive, so it walks the whole tree. Here
        basic.target/sockets.target are already active and systemd does not re-pull their Wants, so the
        install targets (sockets.target for the socket) are started as their own anchors."""
        names = deployer.installed_units()
        startable = deployer.startable(names)
        states = enabled(startable)
        if sorted(n for n, s in states.items() if s == 'enabled') != sorted(startable):
            raise RuntimeError('not enabled after deploy: %s' % states)
        deployer.system.systemctl('stop', *names)
        deployer.system.systemctl('reset-failed', *names, check=False)
        active = deployer.system.systemctl('is-active', *names, check=False).stdout.split()
        if any(state in ('active', 'activating') for state in active):
            raise RuntimeError('units still running after stop: %s' % dict(zip(names, active)))
        deployer.system.systemctl('daemon-reload')
        tree = {line.strip() for line in deployer.system.systemctl('list-dependencies', '--plain', 'default.target').stdout.splitlines()}
        missing = sorted(set(startable) - tree)
        if missing:
            raise RuntimeError('default.target does not reach: %s' % missing)
        targets = sorted({t for n in startable for t in re.findall(r'^WantedBy=(.+)$', (deployer.config.units / n).read_text(), re.M)
                          for t in t.split()} - {'default.target'})
        deployer.system.systemctl('start', 'default.target', *targets)
        problems = deployer.health(names)
        if problems:
            raise RuntimeError('; '.join(problems))
        return '%d enabled units stopped; all reachable from default.target; start default.target %s -> %d units healthy' % (
            len(startable), ' '.join(targets), len(names))

    def prune():
        state = deployer.load_state()
        if not deployer.remove_failed_release(from_name) or (ROOT / 'src/companion' / from_name).exists():
            raise RuntimeError('could not prune ' + from_name)
        state['installed'] = [i for i in state['installed'] if i['release'] != from_name]
        state['previous'] = None  # its directory is gone; the rollback round trip is already done
        deployer.save_state(state)
        return 'removed %s (current %s)' % (from_name, deployer.active_release())

    def switch_back(expected):
        """`companion-deploy rollback`: previous release with its unit snapshot, health-checked."""
        release = deployer.rollback()
        if release != expected or deployer.active_release() != expected:
            raise RuntimeError('rollback landed on %s, expected %s' % (release, expected))
        return 'current %s (previous %s)' % (release, (deployer.load_state().get('previous') or {}).get('release'))

    step('clean', clean)
    step('runtime', install_runtime)
    step('install-from', lambda: deployer.deploy(from_tarball) and 'first install of %s, nothing started' % from_name)
    step('init-world', lambda: initialize(from_name))
    step('start-from', lambda: deployer.start() and 'healthy; GET /world ok paused=%s' % operator('GET', '/world')['world'].get('paused'))
    step('legacy-not-enabled', legacy)
    step('upgrade (preflight, switch, health)', lambda: deployer.deploy(to_tarball) and 'current %s' % deployer.active_release())
    # Both directions, while the from-release is still installed: the new release uses the data root
    # (smoke, scenarios), then the old one must run on it again, then the new one after that.
    step('smoke-upgraded', smoke)
    step('scenarios-upgraded', lambda: scenarios(deployer))
    ledger = []
    step('ledger-before-rollback', lambda: ledger.append(usage_rows()) or 'day %s: %d capabilities used' % (ledger[0][0], sum(1 for row in ledger[0][1].values() if row['calls'])))
    step('migration-drill (copy)', lambda: migration_drill(deployer, from_name, to_name))
    step('rollback (to from)', lambda: switch_back(from_name))
    step('smoke-from', smoke)
    declared = []
    step('ledger-rows-of-from', lambda: declared.append(declared_rows()) or ('no usage ledger in the from-release' if declared[0] is None else 'declares %s' % ', '.join(declared[0])))
    step('roll-forward (rollback again)', lambda: switch_back(to_name))
    step('Q3 ledger-survives-rollback', lambda: ledger_survives(ledger[0] if ledger else None, declared[0] if declared else None))
    step('prune-from', prune)
    step('restart-all', restart)
    step('manager-restart (default.target)', manager_restart)
    step('smoke', smoke)
    step('scenarios', lambda: scenarios(deployer))
    step('prod-untouched', prod_untouched, always=True)

    failed = any(ok is False for _n, ok, _d in results)
    print('\n== STAGING SUMMARY %s -> %s (%ds)' % (from_name, to_name, time.time() - started))
    for name, ok, detail in results:
        print('%-36s %-4s %s' % (name, {True: 'PASS', False: 'FAIL', None: 'SKIP'}[ok], detail))
    if failed:
        for line in diagnostics(deployer):
            print(line)
    # The final replay (after the rollback round trip); the earlier one if the lifecycle stopped before it.
    replayed = next(((ok, detail) for name, ok, detail in reversed(results) if name.startswith('scenarios') and ok is not None), (None, 'skipped'))
    print('SCENARIOS %s' % (replayed[1] if replayed[0] is True else 'FAILED: ' + replayed[1] if replayed[0] is False else 'not run'))
    print('STAGING %s' % ('FAILED' if failed else 'PASSED'))
    return 1 if failed else 0


def replay(only=None):
    """Scenarios alone, against whatever release the last lifecycle left in ~/companion-staging."""
    if not (ROOT / 'src/companion/current').exists():
        raise SystemExit('no staged release: run the lifecycle first')
    deployer = build(load_companion_deploy())
    ok, detail = True, ''
    print('== scenarios', flush=True)
    try:
        detail = scenarios(deployer, only)
        prod_untouched()
    except Exception as error:
        ok, detail = False, '%s: %s' % (error.__class__.__name__, str(error)[:600])
        for line in diagnostics(deployer):
            print(line)
    print('SCENARIOS %s' % (detail if ok else 'FAILED: ' + detail))
    return 0 if ok else 1


def reset():
    root = safe_root()
    stop_fake_onebot()
    names = sorted(p.name for p in UNITS_DIR.glob(PREFIX + '*') if re.match(r'^' + PREFIX + r'[A-Za-z0-9-]+\.(service|socket)$', p.name))
    env = {**os.environ, 'XDG_RUNTIME_DIR': os.environ.get('XDG_RUNTIME_DIR', '/run/user/%d' % os.getuid())}
    if names:
        subprocess.run(['systemctl', '--user', 'disable', *names], capture_output=True, timeout=180, env=env)
        subprocess.run(['systemctl', '--user', 'stop', *names], capture_output=True, timeout=180, env=env)
        subprocess.run(['systemctl', '--user', 'reset-failed', *names], capture_output=True, timeout=60, env=env)
        for name in names:
            (UNITS_DIR / name).unlink()
    # Enablement links left behind (e.g. a unit file removed before it was disabled) must not survive a reset.
    links = [p for p in UNITS_DIR.glob('*.wants/' + PREFIX + '*') if p.is_symlink()]
    for link in links:
        link.unlink()
    if names or links:
        subprocess.run(['systemctl', '--user', 'daemon-reload'], capture_output=True, timeout=60, env=env)
    if root.exists():
        for current, dirs, _files in os.walk(root):
            os.chmod(current, 0o700)  # releases are sealed 0555
        shutil.rmtree(root)
    print('reset: removed %d staging units, %d enablement links and %s' % (len(names), len(links), root))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    life = sub.add_parser('lifecycle')
    life.add_argument('--from', dest='source', required=True)
    life.add_argument('--to', dest='target', required=True)
    sub.add_parser('reset')
    sub.add_parser('scenarios').add_argument('--only')
    options = parser.parse_args(argv)
    if os.geteuid() == 0:
        raise SystemExit('staging must not run as root')
    os.umask(0o077)
    if options.command == 'reset':
        return reset()
    safe_root()
    if options.command == 'scenarios':
        return replay(options.only)
    return lifecycle(Path(options.source).resolve(), Path(options.target).resolve())


if __name__ == '__main__':
    sys.exit(main())
