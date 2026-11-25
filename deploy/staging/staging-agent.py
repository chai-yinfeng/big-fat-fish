#!/usr/bin/python3
"""Release lifecycle test on the dev host, as the unprivileged agent account.

Uploaded and driven by deploy/staging/run.mjs from the Mac. It reuses
companion-deploy itself (same deploy, preflight, unit, health and retention
code) with a staging Config/System: everything lives below
~/companion-staging, which acts as the service HOME. Units are renamed
companion-staging-*, the operator socket listens on 127.0.0.1:13082, and the
memory and QQ units are limited to Unix sockets, so no release (old ones have
3082/3001 hard-coded) can reach production ports. The room page listens on
127.0.0.1:14173. No sudo, no QQ login, no
model key, no provider call.

The scenarios in tools/scenarios.json are replayed against the upgraded release: a fake
OneBot (tools/fake-onebot.mjs) stands in for NapCat, and the release's own model gateway
runs with a scripted upstream (tools/fake-model.mjs). A second, non-QQ channel
(tools/fake-channel.mjs, the test-only MOCK channel) runs beside QQ with its own Authority
credential and its own instance of the release's conversation executor.

Both directions are tested. After the upgrade has been smoked and has replayed the
scenarios, tools/migration-drill.mjs drills a schema migration on a copy of the
database (new release migrates behind a backup, old release still opens and writes it),
`companion-deploy rollback` returns to the from-release on the data root the new one
used, and a second rollback rolls forward again before the from-release is pruned.

Forgetting is followed across the round trip too: under the new release one message is
forgotten while the QQ bridge is stopped, so its cleanup job waits for that one party; the
from-release must list the job as pending and refuse to resume the world; after the
roll-forward the new release's services close it by confirming, and the world resumes.

The room page (companion-room unit) is followed through all of it: unprepared after the
upgrade (page up, state 503), prepared by the release's ops/prepare-room.mjs, gone after
the rollback while its credential files stay in the data root (the old Authority must
start with them there), back after the roll-forward and after a manager restart.

  staging-agent.py lifecycle --from <tarball> --to <tarball>
  staging-agent.py scenarios [--only S1,S3]
  staging-agent.py reset
"""
import argparse
import hashlib
import http.client
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
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
OPERATOR_PORT, ONEBOT_PORT, ROOM_PORT = 13082, 13001, 14173
INITIATION_POLL_MS = 3000  # scenario replay: how often the QQ bridge asks for an initiated run (production: 60 s)
# scenario replay: the QQ bridge still merges a burst, but waits briefly and sends split replies without pauses
SCENARIO_PACING = {'burstQuietMs': 500, 'burstMaxWaitMs': 1500, 'gapBaseMs': 0, 'gapPerLogMs': 0, 'gapJitterMs': 0, 'gapMinMs': 0, 'gapMaxMs': 0, 'firstMinMs': 0, 'firstMaxMs': 0}
PROD_PORTS = (3001, 3082, 6099, 4173)
UNIX_ONLY = ('memory', 'qq')  # their old code dials 127.0.0.1:3082 / :3001
PROXY = 'http://127.0.0.1:7890'
BASE = ROOT / '.local/share/companion-world-v1'
NODE = ROOT / '.local/opt/companion/bin/node'
JOURNAL_LINES = 15
SCENARIO = ROOT / 'scenario'  # fake OneBot control socket, model script and request log
FAKE_ONEBOT = 'companion-staging/tools/fake-onebot.mjs'
FAKE_CHANNEL = 'companion-staging/tools/fake-channel.mjs'  # the second, non-QQ channel of the scenario replay
MOCK_CHANNEL = BASE / 'mock-channel'  # its credential, its executor's config and sessions


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
    for production in ('/room/serve.mjs 4173 ', '127.0.0.1:4173'):  # the room page's loopback port: its argument, and prose about it
        text = text.replace(production, production.replace('4173', str(ROOM_PORT)))
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
    # operatorPort: only a from-release from before driver step 7c reads it (its worker dialled the operator port).
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


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('staging', timeout=15)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(15)
        self.sock.connect(self.path)


def unix_get(path, route, token=None):
    """HTTP GET over a Unix socket; returns (status, body text)."""
    connection = UnixConnection(path)
    connection.request('GET', route, headers={'authorization': 'Bearer ' + token} if token else {})
    response = connection.getresponse()
    text = response.read(65536).decode('utf8', 'replace')
    connection.close()
    return response.status, text


def room_page(route):
    connection = http.client.HTTPConnection('127.0.0.1', ROOM_PORT, timeout=15)
    connection.request('GET', route)
    response = connection.getresponse()
    text = response.read().decode('utf8', 'replace')
    connection.close()
    return response.status, text


ROOM_KEYS = {'version', 'source', 'at', 'since', 'clock', 'weather', 'lamp', 'activity', 'pose'}
ROOM_FILES = ('operator/room-credential.json', 'room-config/room.token')


def room_listener():
    """Local addresses listening on the room port; the unit must bind loopback only."""
    out = subprocess.run(['ss', '-Hltn', 'sport = :%d' % ROOM_PORT], capture_output=True, text=True, timeout=10).stdout
    return sorted(line.split()[3] for line in out.splitlines() if len(line.split()) > 3)


def room_ready(release):
    """Whether scenario replay can read the notebook through the room page: the release has the room's diary route
    and the owner's one-time room step has been done on this data root (its credential files exist)."""
    serve = release / 'room/serve.mjs'
    return serve.exists() and 'v1/room/diary' in serve.read_text() and all((BASE / name).exists() for name in ROOM_FILES)


def room_unprepared():
    """Right after the upgrade of a world that never had a room: the unit runs, the page is served, and the
    state route says unavailable (no reason) because there is no credential yet."""
    if any((BASE / name).exists() for name in ROOM_FILES):
        raise RuntimeError('the from-release left a room credential; this step expects none')
    page, state = room_page('/'), room_page('/state')
    if page[0] != 200 or '<html' not in page[1].lower() or state != (503, '{}'):
        raise RuntimeError('page %d, state %d %s' % (page[0], state[0], state[1][:40]))
    if room_listener() != ['127.0.0.1:%d' % ROOM_PORT]:
        raise RuntimeError('room listener is %s' % room_listener())
    return 'page 200, state 503 {} (no credential yet); listening on 127.0.0.1:%d only' % ROOM_PORT


def room_prepare(release):
    """The owner's one-time step, run by the release itself: token and hash in their own private files, nothing
    added to authority.json (an older Authority refuses a room credential listed there)."""
    out = json.loads(run([str(NODE), str(ROOT / 'src/companion' / release / 'ops/prepare-room.mjs')]))
    again = json.loads(run([str(NODE), str(ROOT / 'src/companion' / release / 'ops/prepare-room.mjs')]))
    if out.get('prepared') is not True or out.get('authorityRestartRequired') is not True or again.get('credentialPreserved') is not True:
        raise RuntimeError('unexpected prepare-room result')
    for name in ROOM_FILES:
        if (BASE / name).stat().st_mode & 0o777 != 0o600:
            raise RuntimeError('%s is not 0600' % name)
    if any(row.get('role') == 'room' for row in json.loads((BASE / 'operator/authority.json').read_text())['credentials']):
        raise RuntimeError('a room credential was written into authority.json')
    return 'prepare-room: token and hash files 0600, authority.json untouched, second run kept the credential'


def room_check():
    """The page, its state from Authority, and what the room credential may and may not do on the Authority socket."""
    token = (BASE / 'room-config/room.token').read_text().strip()
    other = (BASE / 'service-config/health.token').read_text().strip()
    sock = BASE / 'ipc/authority/authority.sock'
    seen = []
    for route in ('/', '/manifest.json', '/room.js', '/state'):
        status, text = room_page(route)
        if status != 200 or token in text:
            raise RuntimeError('room page %s -> %d' % (route, status))
        seen.append(text)
    state = json.loads(seen[-1])
    if set(state) != ROOM_KEYS or state.get('source') != 'authority' or state.get('version') != 1:
        raise RuntimeError('room state is outside the contract: %s' % sorted(state))
    for route in ('/room.token', '/../room-config/room.token', '/.env'):
        if room_page(route)[0] != 404:
            raise RuntimeError('room page answered %s' % route)
    status, body = unix_get(sock, '/v1/room', token)
    if status != 200 or set(json.loads(body).get('value', {})) != ROOM_KEYS:
        raise RuntimeError('GET /v1/room with the room credential -> %d' % status)
    refused = {route: unix_get(sock, route, token)[0] for route in ('/v1/health', '/v1/admin/state', '/v1/receipts/x')}
    refused['POST /v1/observations'] = unix_post(sock, '/v1/observations', token)
    refused['POST /v1/room'] = unix_post(sock, '/v1/room', token)
    refused['POST /v1/context'] = unix_post(sock, '/v1/context', token)
    if any(code != 403 for code in refused.values()):
        raise RuntimeError('the room credential was not refused everywhere else: %s' % refused)
    if unix_get(sock, '/v1/room', other)[0] != 403 or unix_get(sock, '/v1/room')[0] != 401 or unix_get(sock, '/v1/health', other)[0] != 200:
        raise RuntimeError('GET /v1/room is open to another credential, or the health credential stopped working')
    if unix_get(BASE / 'ipc/operator/operator.sock', '/world', token)[0] == 200:
        raise RuntimeError('the operator socket accepted the room credential')
    if room_listener() != ['127.0.0.1:%d' % ROOM_PORT]:
        raise RuntimeError('room listener is %s' % room_listener())
    return 'page+state 200 activity=%s; room credential: GET /v1/room 200, %d other routes 403; other credential 403, none 401; loopback %d only' % (
        state.get('activity'), len(refused), ROOM_PORT)


def room_after_rollback(release):
    """After `rollback` to the from-release. One without the room: its unit is gone and nothing listens, while the
    credential files stay in the data root (that this Authority started with them there is the point of the step)."""
    if (ROOT / 'src/companion' / release / 'room/serve.mjs').is_file():
        return 'from-release has the room too: ' + room_check()
    if (UNITS_DIR / (PREFIX + 'room.service')).exists() or room_listener():
        raise RuntimeError('the room unit or its listener survived the rollback')
    if not all((BASE / name).is_file() for name in ROOM_FILES):
        raise RuntimeError('the rollback removed a room credential file')
    status = unix_get(BASE / 'ipc/authority/authority.sock', '/v1/room', (BASE / 'room-config/room.token').read_text().strip())[0]
    if status == 200:
        raise RuntimeError('the from-release answered the room credential')
    return 'no room unit, nothing on %d; old Authority healthy with the credential files in place and does not know the credential (%d)' % (ROOM_PORT, status)


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
    today's batches unused; no day's diaries count as written (the diary markers go, the private one and each
    person's open one, so the day an earlier replay had written can be triggered again). Digests, facts and
    diaries already written stay, and so does the open diary's list. Returns the number of conversations."""
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
            own.pop('diary', None)
            own.pop('openDiary', None)
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
        db.execute("DELETE FROM maintenance_tasks WHERE mode IN ('consolidation','diary','diary.open')")
        db.commit()
        return count
    finally:
        db.close()


def reset_initiations(database):
    """Deterministic reruns of the initiation scenarios, while Authority is stopped: no request of an earlier
    replay is still open (one that was out when its replay died would hold the next ones back for minutes) and
    the quiet hours are the default again. Her private wake-up starts over as well (its switch off, no wake-up of an
    earlier replay counted against the day, no fuse still hit, every person's switch and reach-out record, her moods, notes and wake log gone).
    Returns whether there was anything to remove."""
    if not Path(database).exists():
        return False
    db = sqlite3.connect(str(database))
    try:
        removed = db.execute("DELETE FROM metadata WHERE key IN ('initiations','initiative','initiative.log')").rowcount > 0
        db.commit()
        return removed
    finally:
        db.close()


def config_keys(release):
    """The keys each operator file's config module reads ({'qq-bridge.json': frozenset, ...}), printed by the release's
    ops/config-keys.mjs; None for a release from before that script (its source is searched instead, see `knows`)."""
    script = release / 'ops/config-keys.mjs'
    if not script.is_file():
        return None
    return {label: frozenset(keys) for label, keys in json.loads(run([str(NODE), str(script)]))['files'].items()}


def release_knows(keys, label, release, source):
    """What `knows` searches for operator/<label>: the key names from `config_keys`, or, without them, the text of the
    release's `source` file that reads it."""
    return keys[label] if keys is not None else (release / source).read_text()


def knows(known, key, needle=None):
    """Whether a release reads `key`: `known` is either the key names of that file (a frozenset from config_keys) or,
    for a release from before ops/config-keys.mjs, the source text that reads the file, searched for `needle` (default:
    the key itself)."""
    if isinstance(known, (set, frozenset)):
        return key in known
    return (needle or key) in known


def scenario_bridge_config(config, bridge_known):
    """qq-bridge.json for scenario replay: a release whose bridge fetches initiated runs asks every few seconds
    (production: every minute), so those scenarios do not wait minutes; one that paces its replies (`pacing`) waits
    briefly for a burst and sends without pauses. Other releases are left alone. Idempotent."""
    if knows(bridge_known, 'initiationPollMs'):
        config['initiationPollMs'] = INITIATION_POLL_MS
    if knows(bridge_known, 'pacing', 'cfg.pacing'):
        config['pacing'] = dict(SCENARIO_PACING)
    return config


def scenario_content_config(config, content_known, replaying):
    """content.json while scenarios replay: staging has no image runtime, so a release that knows `allowRawSmallPng`
    lets the fake OneBot's small PNGs go to the scripted vision model as they are. Taken out again after the replay
    (`replaying` false): production never has it, and an older release refuses the key on a rollback. Idempotent."""
    if replaying and knows(content_known, 'allowRawSmallPng'):
        config['allowRawSmallPng'] = True
    else:
        config.pop('allowRawSmallPng', None)
    return config


def video_scenario_config(site, node, tools, runtime):
    """operator/providers/video.json for scenario replay: the MOCK site only, answered by tools/fake-ytdlp.mjs and
    tools/fake-ffmpeg.mjs (no network is used, nothing is decoded), run inside bubblewrap as production runs yt-dlp and
    ffmpeg: the node runtime and the tools read-only, the job's work directory the only writable place. Staging has no
    speech model, so no audio is downloaded; the stand-in ffmpeg only finds the cuts of a video and takes its stills."""
    return {'schemaVersion': 1, 'ytdlp': [str(node), str(tools / 'fake-ytdlp.mjs')], 'ffmpeg': [str(node), str(tools / 'fake-ffmpeg.mjs')],
            'sandbox': {'kind': 'bwrap', 'bwrap': '/usr/bin/bwrap', 'readOnly': [str(runtime), str(tools)]}, 'sites': [site]}


def scenario_video_config(release, replaying):
    """Written while scenarios replay, for a release that has the video capability; removed afterwards (production
    never has a MOCK site; an older release does not read the file). Returns whether it is in place."""
    target = BASE / 'operator/providers/video.json'
    if not replaying or not (release / 'capabilities/providers/video/provider.js').is_file():
        target.unlink(missing_ok=True)
        return False
    listed = subprocess.run([str(NODE), str(TOOLS / 'fake-ytdlp.mjs'), '--mock-site'], env={'PATH': '/usr/bin:/bin', 'HOME': str(ROOT), 'LANG': 'C.UTF-8'},
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30, check=True)
    target.parent.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(json.dumps(video_scenario_config(json.loads(listed.stdout), NODE, TOOLS, ROOT / '.local/opt/companion')) + '\n')
    return True


def stop_fake_onebot():
    subprocess.run(['pkill', '-U', str(os.getuid()), '-f', FAKE_ONEBOT], capture_output=True, timeout=20)


def stop_fake_channel():
    # The bridge first (it stops its own executor), then an executor a killed bridge left behind.
    for pattern in (FAKE_CHANNEL, str(MOCK_CHANNEL / 'conversation.json')):
        subprocess.run(['pkill', '-U', str(os.getuid()), '-f', pattern], capture_output=True, timeout=20)


def mock_authority_config(config, token_hash):
    """authority.json with the test-only MOCK channel: its capability, the one credential for it, and the explicit
    switch without which Authority refuses a test-only channel (an older release ignores the switch and treats the
    capability like any other). Idempotent."""
    config['credentials'] = [row for row in config['credentials'] if row.get('capabilityId') != 'mock'] + [{'hash': token_hash, 'role': 'capability', 'capabilityId': 'mock'}]
    if not any(row.get('id') == 'mock' for row in config['capabilities']):
        config['capabilities'].append({'id': 'mock', 'policy': 'conversation.v1'})
    config['operator']['allowTestChannels'] = True
    return config


def scenario_authority_config(config):
    """authority.json while scenarios replay: the staging-only switch behind the operator's diary trigger, so a replay
    can have the running day's diary written now (production writes a day only after it has ended). Like
    `allowTestChannels` it stays afterwards; an older release ignores it. Idempotent."""
    config['operator']['allowDiaryTrigger'] = True
    return config


def mock_executor_config(conversation, root=None):
    """The conversation executor of the MOCK channel: the release's executor configuration with its own socket,
    caller token, sessions and, above all, the MOCK capability credential instead of the QQ one."""
    root = Path(root or MOCK_CHANNEL)
    caller = (root / 'caller.token').read_text().strip()
    return {**conversation, 'socketPath': str(root.parent / 'ipc/mock-channel/execute.sock'), 'callerTokenHash': hashlib.sha256(caller.encode()).hexdigest(),
            'sessionsDir': str(root / 'sessions'), 'authority': {**conversation['authority'], 'tokenFile': str(root / 'capability.token')}}


def prepare_mock_channel(release):
    """While the units are stopped. Returns False for a release without channel declarations (it has no second
    channel to replay): nothing is written then."""
    if not (release / 'capabilities/channels/mock/manifest.js').is_file():
        return False
    for directory in (MOCK_CHANNEL, MOCK_CHANNEL / 'sessions', BASE / 'ipc/mock-channel'):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ('capability.token', 'caller.token'):
        path = MOCK_CHANNEL / name
        if not path.exists():
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as handle:
                handle.write(secrets.token_urlsafe(32) + '\n')
    token_hash = hashlib.sha256((MOCK_CHANNEL / 'capability.token').read_text().strip().encode()).hexdigest()
    edit('authority.json', lambda c: mock_authority_config(c, token_hash))
    path = MOCK_CHANNEL / 'conversation.json'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(json.dumps(mock_executor_config(json.loads((BASE / 'operator/conversation.json').read_text()))) + '\n')
    return True


def scenarios(deployer, only=None):
    """Replay tools/scenarios.json against the current release; returns the summary line."""
    data = json.loads((TOOLS / 'scenarios.json').read_text())
    release = ROOT / 'src/companion/current'
    qq_config = json.loads((BASE / 'operator/qq-bridge.json').read_text())
    # The QQ unit loses its Unix-socket-only restriction below: it must dial the staging port, never NapCat's.
    keys = config_keys(release)
    bridge_known = release_knows(keys, 'qq-bridge.json', release, 'capabilities/qq/main.mjs')
    if qq_config.get('onebotPort') != ONEBOT_PORT or not knows(bridge_known, 'onebotPort'):
        raise RuntimeError('this release cannot be pointed at the fake OneBot port %d' % ONEBOT_PORT)
    names = deployer.installed_units()
    stop_fake_onebot()
    stop_fake_channel()
    deployer.stop_all(names)
    second_channel = prepare_mock_channel(release)
    edit('authority.json', scenario_authority_config)
    edit('qq-bridge.json', lambda c: scenario_bridge_config(c, bridge_known))
    content_known = release_knows(keys, 'content.json', release, 'capabilities/media/main.mjs')
    edit('content.json', lambda c: scenario_content_config(c, content_known, True))
    scenario_video_config(release, True)
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
    # What earlier replays' pictures were, and the stickers the owner had her keep: every replay starts without them.
    (BASE / 'media-data/describe-cache.json').unlink(missing_ok=True)
    if (BASE / 'media-data/stickers').is_dir() and not (BASE / 'media-data/stickers').is_symlink():
        shutil.rmtree(BASE / 'media-data/stickers')
    # Videos an earlier replay watched (their notes, and a site marked blocked): every replay starts without them.
    if (BASE / 'media-data/video-cache').is_dir() and not (BASE / 'media-data/video-cache').is_symlink():
        shutil.rmtree(BASE / 'media-data/video-cache')
    dispatch = Path(qq_config['stateFile'])
    if dispatch.exists():
        state = json.loads(dispatch.read_text())
        if state.pop('budgetNotice', None) is not None:
            dispatch.write_text(json.dumps(state) + '\n')
    SCENARIO.mkdir(mode=0o700, exist_ok=True)
    (SCENARIO / 'model-script.json').write_text('[]\n')
    (SCENARIO / 'model-requests.jsonl').write_text('')
    control, mock_control = SCENARIO / 'onebot.sock', SCENARIO / 'mock.sock'
    mock_control.unlink(missing_ok=True)
    mock = None
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
        if second_channel:
            # After the units: the bridge starts its own executor, which needs Authority and the gateway.
            mock = subprocess.Popen([str(NODE), str(TOOLS / 'fake-channel.mjs'), '--release', str(release), '--control', str(mock_control),
                                     '--authority-socket', str(BASE / 'ipc/authority/authority.sock'), '--authority-token-file', str(MOCK_CHANNEL / 'capability.token'),
                                     '--executor-config', str(MOCK_CHANNEL / 'conversation.json'), '--caller-token-file', str(MOCK_CHANNEL / 'caller.token'), '--poll-ms', str(INITIATION_POLL_MS)],
                                    cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            deadline = time.time() + 30
            while not mock_control.is_socket():
                if mock.poll() is not None or time.time() > deadline:
                    raise RuntimeError('fake channel did not start: %s' % (mock.stderr.read().strip()[-200:] if mock.poll() is not None else 'timeout'))
                time.sleep(0.2)
        command = [str(NODE), str(TOOLS / 'scenarios.mjs'), '--operator-port', str(OPERATOR_PORT), '--operator-token-file', str(BASE / 'operator/console.token'),
                   '--onebot-control', str(control), '--model-script', str(SCENARIO / 'model-script.json'), '--model-log', str(SCENARIO / 'model-requests.jsonl'),
                   '--scenarios', str(TOOLS / 'scenarios.json'),
                   '--inference-socket', str(BASE / 'ipc/model/inference.sock'), '--inference-token-file', str(BASE / 'service-config/inference.token')] + (['--mock-control', str(mock_control)] if second_channel else []) + (['--room-port', str(ROOM_PORT)] if room_ready(release) else []) + (['--only', only] if only else [])
        result = subprocess.run(command, cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=1800)
    finally:
        for process in (fake, mock):
            if process is None:
                continue
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        scenario_video_config(release, False)
        stop_fake_channel()
        edit('content.json', lambda c: scenario_content_config(c, content_known, False))
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


def cleanup_waiting(job):
    """The parties of cleanup job `job` that have not confirmed, or None once the job is closed."""
    row = next((item for item in operator('GET', '/memory/cleanup/status')['jobs'] if item['id'] == job), None)
    if row is None:
        raise RuntimeError('cleanup job %s is not listed' % job)
    return None if row['status'] == 'complete' else sorted(party['party'] for party in row['parties'] if not party['confirmed'])


def cleanup_carry(deployer, carried):
    """New release, before the rollback: with the QQ bridge stopped, forget one message that only QQ conversations
    are affected by. The content service and the executor confirm while they run; the job is left waiting for the
    bridge alone and the world paused. `carried` receives the job id."""
    bridge = [name for name in deployer.installed_units() if name.endswith('-qq.service')]
    if len(bridge) != 1:
        raise RuntimeError('expected one QQ bridge unit, found %s' % bridge)
    deployer.system.systemctl('stop', *bridge)
    world = operator('GET', '/world')['world']
    if not world['paused']:
        operator('POST', '/world/pause', {'paused': True, 'expectedRevision': world['revision']})
    chosen = None
    for item in operator('GET', '/memory?limit=100')['items']:
        observation = (item.get('evidence') or {}).get('observationId')
        if item.get('status') != 'active' or not observation:
            continue
        preview = operator('POST', '/memory/forget-preview', {'entityId': item['entityId'], 'ids': [observation]})
        if preview.get('epochScope') == 'streams' and preview['affectedStreams'] and all(stream['capabilityId'] == 'qq' for stream in preview['affectedStreams']):
            chosen = (item['entityId'], observation, preview['memoryEpoch'])
            break
    if chosen is None:
        raise RuntimeError('no memory of a QQ-only person to forget (the scenario replay leaves several)')
    job = operator('POST', '/memory/forget', {'entityId': chosen[0], 'ids': [chosen[1]], 'expectedMemoryEpoch': chosen[2]})['id']
    carried.append(job)
    deadline, waiting = time.time() + 90, None
    while time.time() < deadline:
        waiting = cleanup_waiting(job)
        if waiting == ['bridge:qq']:
            return 'job %s: content and executor confirmed, waiting for bridge:qq (stopped); world paused' % job[:8]
        time.sleep(1)
    raise RuntimeError('cleanup job waits for %s, expected only bridge:qq' % waiting)


def cleanup_under_from(job):
    """From-release, after the rollback: the job the new release left is still pending there and still holds the world."""
    if job is None:
        raise RuntimeError('no cleanup job was carried over the rollback')
    if not any(item.get('id') == job for item in operator('GET', '/memory/cleanup/pending')):
        raise RuntimeError('the from-release does not list cleanup job %s as pending' % job)
    world = operator('GET', '/world')['world']
    if not world['paused']:
        raise RuntimeError('the world is running with a cleanup pending')
    try:
        operator('POST', '/world/pause', {'paused': False, 'expectedRevision': world['revision']})
    except RuntimeError as error:
        if '-> 409' not in str(error):
            raise
        return 'job %s pending under the from-release; resume refused (409)' % job[:8]
    raise RuntimeError('the from-release resumed the world with a cleanup pending')


def cleanup_closes(job):
    """New release again, after the roll-forward: its running services confirm what was left, and the world resumes."""
    if job is None:
        raise RuntimeError('no cleanup job was carried over the rollback')
    deadline, waiting = time.time() + 150, None
    while time.time() < deadline:
        waiting = cleanup_waiting(job)
        if waiting is None:
            break
        time.sleep(2)
    if waiting is not None:
        raise RuntimeError('after the roll-forward the cleanup still waits for %s' % waiting)
    row = next(item for item in operator('GET', '/memory/cleanup/status')['jobs'] if item['id'] == job)
    if row.get('completedBy') != 'parties':
        raise RuntimeError('the cleanup was closed by %s, not by the services' % row.get('completedBy'))
    world = operator('GET', '/world')['world']
    operator('POST', '/world/pause', {'paused': False, 'expectedRevision': world['revision']})
    if operator('GET', '/world')['world']['paused']:
        raise RuntimeError('the world did not resume after the cleanup closed')
    return 'job %s closed by %s; world resumed' % (job[:8], ', '.join(party['party'] for party in row['parties']))


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
    step('room-unprepared', room_unprepared)
    step('room-prepare', lambda: room_prepare(to_name))
    step('room-restart', restart)
    step('room-upgraded', room_check)
    step('smoke-upgraded', smoke)
    step('scenarios-upgraded', lambda: scenarios(deployer))
    ledger = []
    step('ledger-before-rollback', lambda: ledger.append(usage_rows()) or 'day %s: %d capabilities used' % (ledger[0][0], sum(1 for row in ledger[0][1].values() if row['calls'])))
    step('migration-drill (copy)', lambda: migration_drill(deployer, from_name, to_name))
    carried = []
    step('forget-pending-before-rollback', lambda: cleanup_carry(deployer, carried))
    step('rollback (to from)', lambda: switch_back(from_name))
    step('forget-pending-under-from', lambda: cleanup_under_from(carried[0] if carried else None))
    step('room-after-rollback', lambda: room_after_rollback(from_name))
    step('smoke-from', smoke)
    declared = []
    step('ledger-rows-of-from', lambda: declared.append(declared_rows()) or ('no usage ledger in the from-release' if declared[0] is None else 'declares %s' % ', '.join(declared[0])))
    step('roll-forward (rollback again)', lambda: switch_back(to_name))
    step('forget-closes-after-roll-forward', lambda: cleanup_closes(carried[0] if carried else None))
    step('room-after-roll-forward', room_check)
    step('Q3 ledger-survives-rollback', lambda: ledger_survives(ledger[0] if ledger else None, declared[0] if declared else None))
    step('prune-from', prune)
    step('restart-all', restart)
    step('manager-restart (default.target)', manager_restart)
    step('smoke', smoke)
    step('room', room_check)
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
    stop_fake_channel()
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
