"""Synthetic tests for the staging agent: unit transform, reset guard, companion-deploy reuse. No host access."""
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
UNITS = HERE.parent / 'authority/isolation/units'
loader = importlib.machinery.SourceFileLoader('staging_agent', str(HERE / 'staging-agent.py'))
sa = importlib.util.module_from_spec(importlib.util.spec_from_loader('staging_agent', loader))
loader.exec_module(sa)
ROOT = Path('/home/agent/companion-staging')


class UnitTransformTests(unittest.TestCase):
    def units(self):
        return dict(sa.staging_unit(u.name, u.read_text(), ROOT) for u in sorted(UNITS.iterdir()))

    def test_every_unit_is_renamed_and_free_of_production_names_paths_and_ports(self):
        units = self.units()
        self.assertEqual(sorted(units), sorted('companion-staging-' + u.name[len('companion-'):] for u in UNITS.iterdir()))
        for name, text in units.items():
            self.assertNotIn('%h', text, name)
            self.assertNotRegex(text, r'\b(3001|3082|6099|4173)\b', name)
            self.assertNotRegex(text, r'\bcompanion-(?!staging-)[A-Za-z0-9-]+\.(service|socket)\b', name)
            self.assertNotIn('/home/companion', text, name)
            if '[Service]' in text:
                self.assertIn('Environment=HOME=%s\n' % ROOT, text, name)
        self.assertIn('ListenStream=127.0.0.1:13082', units['companion-staging-world-public.socket'])
        self.assertIn('Sockets=companion-staging-world-public.socket', units['companion-staging-world-public.service'])
        self.assertIn('%s/.local/share/companion-world-v1/ipc/operator/operator.sock' % ROOT, units['companion-staging-world-public.service'])
        self.assertIn('Requires=companion-staging-authority.service companion-staging-conversation.service', units['companion-staging-qq.service'])
        self.assertIn('ExecStart=/usr/bin/python3 %s/src/companion/current/ops/isolation/launch.py authority' % ROOT, units['companion-staging-authority.service'])
        # The room page: its own loopback port, the staging Authority socket and the staging credential file.
        self.assertIn('ExecStart=%s/.local/opt/companion/bin/node %s/src/companion/current/room/serve.mjs 14173 '
                      '--authority-socket %s/.local/share/companion-world-v1/ipc/authority/authority.sock '
                      '--credential-file %s/.local/share/companion-world-v1/room-config/room.token\n' % ((ROOT,) * 4), units['companion-staging-room.service'])
        self.assertIn('Requires=companion-staging-authority.service', units['companion-staging-room.service'])
        self.assertEqual((sa.ROOM_PORT, 4173 in sa.PROD_PORTS), (14173, True))

    def test_workers_with_hard_coded_production_ports_get_unix_sockets_only(self):
        units = self.units()
        for role in ('memory', 'qq', 'conversation'):
            self.assertIn('RestrictAddressFamilies=AF_UNIX', units['companion-staging-%s.service' % role])
        self.assertNotIn('RestrictAddressFamilies', units['companion-staging-authority.service'])

    def test_units_install_into_the_managers_default_target(self):
        # The manager-restart check relies on enablement pulling every unit in from default.target.
        for name, text in self.units().items():
            if name == 'companion-staging-world-public.service':
                self.assertNotIn('[Install]', text)  # socket activated
            elif name.endswith('.socket'):
                self.assertIn('[Install]\nWantedBy=sockets.target', text, name)
            else:
                self.assertIn('[Install]\nWantedBy=default.target', text, name)

    def test_unknown_or_unconvertible_units_are_refused(self):
        with self.assertRaises(ValueError):
            sa.staging_unit('companion-staging-x.service', '[Service]\n', ROOT)
        with self.assertRaises(ValueError):
            sa.staging_unit('companion-x.service', '[Service]\nExecStart=/bin/true 127.0.0.1:6099\n', ROOT)
        with self.assertRaises(ValueError):  # a room unit whose port is not where the transform expects it
            sa.staging_unit('companion-room.service', '[Service]\nExecStart=/bin/node serve.mjs --port 4173\n', ROOT)


class ScenarioUnitTests(unittest.TestCase):
    def units(self):
        return dict(sa.staging_unit(u.name, u.read_text(), ROOT) for u in sorted(UNITS.iterdir()))

    def test_model_unit_runs_the_release_gateway_through_the_scripted_launcher(self):
        units = self.units()
        model = sa.scenario_unit('companion-staging-model.service', units['companion-staging-model.service'], ROOT)
        self.assertIn('ExecStart=%s/.local/opt/companion/bin/node %s/tools/fake-model.mjs --release %s/src/companion/current '
                      '--config %s/.local/share/companion-world-v1/operator/model-gateway.json '
                      '--script %s/scenario/model-script.json --log %s/scenario/model-requests.jsonl\n' % ((ROOT,) * 6), model)
        self.assertNotIn('model-gateway/main.mjs', model)
        self.assertEqual(model.count('ExecStart='), 1)
        self.assertEqual(sa.scenario_unit('companion-staging-model.service', model, ROOT), model)
        with self.assertRaises(ValueError):
            sa.scenario_unit('companion-staging-model.service', '[Service]\nExecStart=/bin/true\n', ROOT)

    def test_only_the_qq_unit_may_dial_loopback_and_no_unit_names_a_production_port(self):
        units = self.units()
        for name, text in units.items():
            scenario = sa.scenario_unit(name, text, ROOT)
            self.assertNotRegex(scenario, r'\b(3001|3082|6099)\b', name)
            if name == 'companion-staging-qq.service':
                self.assertNotIn('RestrictAddressFamilies', scenario)
            elif name != 'companion-staging-model.service':
                self.assertEqual(scenario, text, name)
        self.assertEqual(sa.ONEBOT_PORT, 13001)


class ResetGuardTests(unittest.TestCase):
    def test_only_exactly_home_companion_staging(self):
        with tempfile.TemporaryDirectory(prefix='staging-home-') as temp:
            home = Path(os.path.realpath(temp)) / 'agent'
            home.mkdir()
            self.assertEqual(sa.safe_root(home / 'companion-staging', home), home / 'companion-staging')
            for bad in (home, home / 'companion-staging/..', home / 'other', Path('/home/companion/companion-staging')):
                with self.assertRaises(SystemExit):
                    sa.safe_root(bad, home)
            (home / 'elsewhere').mkdir()
            os.symlink(home / 'elsewhere', home / 'companion-staging')
            with self.assertRaises(SystemExit):
                sa.safe_root(home / 'companion-staging', home)
        with self.assertRaises(SystemExit):
            sa.safe_root(Path('/companion-staging'), Path('/'))


class ReuseTests(unittest.TestCase):
    def test_staging_drives_companion_deploy_itself_on_staging_units_only(self):
        cd = sa.load_companion_deploy(HERE.parent / 'authority/companion-deploy/companion-deploy')
        self.assertTrue(cd.UNIT_PATTERN.match('companion-staging-authority.service'))
        self.assertFalse(cd.UNIT_PATTERN.match('companion-authority.service'))
        deployer = sa.build(cd)
        self.assertIsInstance(deployer, cd.Deployer)
        self.assertEqual(deployer.config.ports, (13082,))
        self.assertEqual(deployer.config.home, sa.ROOT)
        self.assertEqual(deployer.config.units, sa.UNITS_DIR)
        self.assertTrue(re.match(r'^staging: origin main not checked', deployer.system.git('log', '-1').stdout))


class LifecycleOrderTests(unittest.TestCase):
    def test_rollback_round_trip_happens_after_the_upgrade_was_used_and_before_the_from_release_is_pruned(self):
        steps = re.findall(r"^    step\('([^']+)'", (HERE / 'staging-agent.py').read_text(), re.M)
        order = ['upgrade (preflight, switch, health)', 'room-unprepared', 'room-prepare', 'room-restart', 'room-upgraded', 'smoke-upgraded', 'scenarios-upgraded', 'ledger-before-rollback', 'migration-drill (copy)', 'groups-before-rollback', 'forget-pending-before-rollback', 'rollback (to from)', 'forget-pending-under-from',
                 'group-after-rollback', 'room-after-rollback', 'smoke-from', 'ledger-rows-of-from', 'roll-forward (rollback again)', 'forget-closes-after-roll-forward', 'room-after-roll-forward', 'Q3 ledger-survives-rollback', 'prune-from', 'restart-all', 'manager-restart (default.target)', 'smoke', 'room', 'scenarios', 'prod-untouched']
        self.assertEqual(steps[steps.index(order[0]):], order)

    def test_the_drill_tool_is_uploaded_and_only_ever_given_a_copy(self):
        self.assertIn("'deploy/staging/migration-drill.mjs': 'migration-drill.mjs'", (HERE / 'run.mjs').read_text())
        source = (HERE / 'staging-agent.py').read_text()
        self.assertIn("'--database', str(work / live.name)]", source)
        self.assertEqual(source.count('migration-drill.mjs'), 3)  # docstrings and the one command


class LedgerRollbackTests(unittest.TestCase):
    ROW = {'used': 1, 'calls': 1, 'ok': 1, 'failed': 0, 'denied': {'daily_limit': 1}, 'units': {'inputTokens': 100}, 'costYuan': 0.01, 'busyMs': 20}
    IDLE = {'used': 0, 'calls': 0, 'ok': 0, 'failed': 0, 'denied': {}, 'units': {}, 'costYuan': 0, 'busyMs': 0}

    def answers(self, usage, history=None):
        return lambda method, route, body=None: usage if route == '/usage' else history

    def today(self, day, rows):
        return {'day': day, 'rows': [dict(row, id=name) for name, row in rows.items()]}

    def test_the_days_numbers_must_still_be_there_after_the_old_release_ran_on_the_data_root(self):
        before = ('2026-11-12', {'chat': dict(self.ROW), 'web': dict(self.IDLE)})
        original = sa.operator
        try:
            sa.operator = self.answers(self.today('2026-11-12', before[1]))
            self.assertIn('day 2026-11-12 kept', sa.ledger_survives(before))
            # Counting more since is fine; losing a call, a refusal, a unit or money is not.
            sa.operator = self.answers(self.today('2026-11-12', {'chat': dict(self.ROW, calls=3, ok=3, denied={'daily_limit': 1, 'paused': 2}), 'web': dict(self.IDLE)}))
            sa.ledger_survives(before)
            for lost in ({'calls': 0}, {'denied': {}}, {'units': {}}, {'costYuan': 0}, {'used': 0}):
                sa.operator = self.answers(self.today('2026-11-12', {'chat': dict(self.ROW, **lost), 'web': dict(self.IDLE)}))
                with self.assertRaisesRegex(RuntimeError, 'usage of 2026-11-12 lost across the rollback: chat'):
                    sa.ledger_survives(before)
            sa.operator = self.answers(self.today('2026-11-12', {'web': dict(self.IDLE)}))
            with self.assertRaisesRegex(RuntimeError, 'lost across the rollback: chat'):
                sa.ledger_survives(before)
            # Past Beijing midnight the finished day must be a history line; unused capabilities have none.
            sa.operator = self.answers(self.today('2026-11-13', {'chat': dict(self.IDLE), 'web': dict(self.IDLE)}), {'days': [{'day': '2026-11-12', 'rows': {'chat': dict(self.ROW)}}]})
            self.assertIn('now a history line', sa.ledger_survives(before))
            sa.operator = self.answers(self.today('2026-11-13', {'chat': dict(self.IDLE), 'web': dict(self.IDLE)}), {'days': []})
            with self.assertRaisesRegex(RuntimeError, 'lost across the rollback: chat'):
                sa.ledger_survives(before)
            # A row of a capability the old release does not declare cannot survive it: left out and named.
            # (declared None: the old release has no ledger and touches no file, so every row is compared.)
            newer = ('2026-11-12', {'chat': dict(self.ROW), 'mock': dict(self.ROW)})
            sa.operator = self.answers(self.today('2026-11-12', {'chat': dict(self.ROW)}))
            self.assertIn('not compared, unknown to the from-release: mock', sa.ledger_survives(newer, ['chat', 'web']))
            for declared in (None, ['chat', 'mock']):
                with self.assertRaisesRegex(RuntimeError, 'lost across the rollback: mock'):
                    sa.ledger_survives(newer, declared)
            sa.operator = self.answers(self.today('2026-11-12', {'mock': dict(self.ROW)}))
            with self.assertRaisesRegex(RuntimeError, 'lost across the rollback: chat'):
                sa.ledger_survives(newer, ['chat'])
            self.assertEqual(sa.declared_rows(), ['mock'])
            sa.operator = self.answers(self.today('2026-11-12', before[1]))
            self.assertNotIn('not compared', sa.ledger_survives(before, ['chat', 'web']))
            sa.operator = lambda *_args: (_ for _ in ()).throw(RuntimeError('GET /usage -> 404'))
            self.assertIsNone(sa.declared_rows())
            # An empty ledger, or none noted, proves nothing.
            with self.assertRaisesRegex(RuntimeError, 'empty before the rollback'):
                sa.ledger_survives(('2026-11-12', {'chat': dict(self.IDLE)}))
            with self.assertRaisesRegex(RuntimeError, 'no usage rows were noted'):
                sa.ledger_survives(None)
        finally:
            sa.operator = original

    def test_a_replay_resets_the_ledger_together_with_the_spend_meter_but_keeps_its_history(self):
        source = (HERE / 'staging-agent.py').read_text()
        self.assertIn("for label in ('spend.json', 'spend-settings.json', 'capability-usage.json', 'usage-ledger.json', 'usage-limits.json'):", source)
        self.assertNotIn("'usage-history.jsonl'", source)
        self.assertIn("(model_data / 'provider-jobs.json').unlink(missing_ok=True)", source)
        self.assertNotIn("'providers.json'", source)


class CleanupUnderFromTests(unittest.TestCase):
    JOB = 'job-1234-abcd'

    def answers(self, status, pending, paused=True, resume=409):
        def operator(method, route, body=None):
            if route == '/memory/cleanup/status':
                if status is None:
                    raise RuntimeError('GET /memory/cleanup/status -> 404 NOT_FOUND')
                return {'jobs': [status]}
            if route == '/memory/cleanup/pending':
                return pending
            if route == '/world':
                return {'world': {'paused': paused, 'revision': 3}}
            if route == '/world/pause' and resume:
                raise RuntimeError('POST /world/pause -> %d CONFLICT' % resume)
            return {}
        return operator

    def row(self, bridge, completed='parties'):
        return {'id': self.JOB, 'status': 'complete' if completed else 'pending', 'completedBy': completed,
                'parties': [{'party': 'content', 'confirmed': True, 'report': {}}, {'party': 'executor:qq', 'confirmed': True, 'report': {}}, bridge]}

    def test_a_from_release_before_7b_keeps_the_job_and_one_from_7b_on_closes_it_by_its_bridge(self):
        original, sleep = sa.operator, sa.time.sleep
        try:
            sa.time.sleep = lambda _seconds: None
            # Before 7b: no status route; the job is pending and resuming is refused.
            sa.operator = self.answers(None, [{'id': self.JOB}])
            self.assertIn('resume refused (409)', sa.cleanup_under_from(self.JOB))
            sa.operator = self.answers(None, [])
            with self.assertRaisesRegex(RuntimeError, 'does not list cleanup job'):
                sa.cleanup_under_from(self.JOB)
            sa.operator = self.answers(None, [{'id': self.JOB}], resume=0)
            with self.assertRaisesRegex(RuntimeError, 'resumed the world with a cleanup pending'):
                sa.cleanup_under_from(self.JOB)
            # 7b on: the from-release bridge confirms, the parties close the job, the world stays paused.
            bridge = {'party': 'bridge:qq', 'confirmed': True, 'report': {'dispatchForgotten': 1}}
            sa.operator = self.answers(self.row(bridge), [])
            self.assertIn('closed under the from-release by its bridge:qq', sa.cleanup_under_from(self.JOB))
            sa.operator = self.answers(self.row(bridge, completed='operator'), [])
            with self.assertRaisesRegex(RuntimeError, 'not closed by the from-release bridge'):
                sa.cleanup_under_from(self.JOB)
            sa.operator = self.answers(self.row(bridge), [{'id': 'other'}])
            with self.assertRaisesRegex(RuntimeError, 'still lists a cleanup as pending'):
                sa.cleanup_under_from(self.JOB)
            sa.operator = self.answers(self.row(bridge), [], paused=False)
            with self.assertRaisesRegex(RuntimeError, 'resumed without the operator'):
                sa.cleanup_under_from(self.JOB)
            clock = iter(range(0, 1000, 50))
            sa.time.time, now = (lambda: next(clock)), sa.time.time
            try:
                sa.operator = self.answers(self.row({'party': 'bridge:qq', 'confirmed': False, 'report': None}, completed=None), [{'id': self.JOB}])
                with self.assertRaisesRegex(RuntimeError, r"still waits for \['bridge:qq'\]"):
                    sa.cleanup_under_from(self.JOB)
            finally:
                sa.time.time = now
            with self.assertRaisesRegex(RuntimeError, 'no cleanup job was carried'):
                sa.cleanup_under_from(None)
        finally:
            sa.operator, sa.time.sleep = original, sleep


class ConsolidationResetTests(unittest.TestCase):
    def test_every_private_conversation_restarts_with_nothing_waiting_and_unused_batches(self):
        import json
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'authority.sqlite'
            self.assertEqual(sa.reset_consolidation(database), 0)  # no database yet
            db = sqlite3.connect(str(database))
            db.executescript('''CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE streams(capability_id TEXT,stream_id TEXT,person_id TEXT,audience TEXT,entity_id TEXT);
                CREATE TABLE observations(id TEXT PRIMARY KEY,capability_id TEXT,stream_id TEXT);
                CREATE TABLE maintenance_tasks(id TEXT PRIMARY KEY,mode TEXT);''')
            db.executemany('INSERT INTO streams VALUES(?,?,?,?,?)', [('qq', 'MOCK-a', 'p1', 'private', 'e'), ('qq', 'MOCK-b', 'p2', 'private', 'e'), ('qq', 'MOCK-group', 'p1', 'shared', 'e')])
            db.executemany('INSERT INTO observations VALUES(?,?,?)', [('o1', 'qq', 'MOCK-a'), ('o2', 'qq', 'MOCK-a'), ('o3', 'qq', 'MOCK-b'), ('o4', 'qq', 'MOCK-group')])
            db.executemany('INSERT INTO maintenance_tasks VALUES(?,?)', [('t1', 'consolidation'), ('t2', 'private'), ('t3', 'diary'), ('t4', 'diary.open')])
            db.commit()
            self.assertEqual(sa.reset_consolidation(database), 0)  # the release before consolidation left no state
            state = {'e': {'since': 5, 'day': '2026-11-10', 'calls': 7, 'deferredAt': 9, 'diary': {'lastDay': '2026-11-10', 'issued': 't3'}, 'openDiary': {'issued': 't4', 'people': {'p1': {'lastDay': '2026-11-10'}}}, 'streams': {'qq\0MOCK-a': {'calls': 2, 'invalid': 2, 'issued': 't1', 'skipped': 1, 'digests': 3, 'lastObservationId': 'o1'}}}}
            db.execute("INSERT INTO metadata VALUES('consolidation',?)", (json.dumps(state),))
            db.commit()
            self.assertEqual(sa.reset_consolidation(database), 2)
            after = json.loads(db.execute("SELECT value FROM metadata WHERE key='consolidation'").fetchone()[0])
            self.assertEqual(after, {'e': {'since': 5, 'day': '2026-11-10', 'calls': 0, 'streams': {
                'qq\0MOCK-a': {'calls': 0, 'invalid': 0, 'skipped': 1, 'digests': 3, 'lastObservationId': 'o2'},
                'qq\0MOCK-b': {'calls': 0, 'invalid': 0, 'lastObservationId': 'o3'}}}})
            self.assertEqual(db.execute('SELECT id FROM maintenance_tasks').fetchall(), [('t2',)])
            db.close()


class InitiationReplayTests(unittest.TestCase):
    def test_a_replay_starts_with_no_open_initiation_and_leaves_everything_else(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'authority.sqlite'
            self.assertFalse(sa.reset_initiations(database))  # no database yet
            db = sqlite3.connect(str(database))
            db.execute('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
            db.executemany('INSERT INTO metadata VALUES(?,?)', [('state', '{}'), ('consolidation', '{}')])
            db.commit()
            self.assertFalse(sa.reset_initiations(database))  # a release before initiations left no state
            db.execute("INSERT INTO metadata VALUES('initiations',?)", ('{"items":[{"id":"MOCK","status":"issued"}],"quiet":{"fromMinute":0,"toMinute":0}}',))
            db.commit()
            self.assertTrue(sa.reset_initiations(database))
            self.assertEqual(db.execute('SELECT key FROM metadata ORDER BY key').fetchall(), [('consolidation',), ('state',)])
            # Her private wake-up starts over too: its switch, schedule, moods and notes, and the wake log.
            db.executemany('INSERT INTO metadata VALUES(?,?)', [('initiative', '{"wake":{"enabled":true},"lastWakeAt":1}'), ('initiative.log', '[{"type":"wake","id":"MOCK"}]')])
            db.commit()
            self.assertTrue(sa.reset_initiations(database))
            self.assertEqual(db.execute('SELECT key FROM metadata ORDER BY key').fetchall(), [('consolidation',), ('state',)])
            db.close()

    def test_raw_small_pngs_only_while_replaying_and_only_for_a_release_that_knows_the_key(self):
        config = {'sharpModule': '/x/node_modules/sharp'}
        knows = "cfg.allowRawSmallPng ?? false"
        self.assertEqual(sa.scenario_content_config(dict(config), knows, True), {**config, 'allowRawSmallPng': True})
        self.assertEqual(sa.scenario_content_config(dict(config), "cfg.sharpModule", True), config)
        self.assertEqual(sa.scenario_content_config({**config, 'allowRawSmallPng': True}, knows, False), config)
        self.assertEqual(sa.scenario_content_config(dict(config), knows, False), config)
        source = (HERE / 'staging-agent.py').read_text()
        self.assertIn("edit('content.json', lambda c: scenario_content_config(c, content_known, True))", source)
        # Taken out in the `finally` of the replay, before anything else (a rollback) can start an older release.
        self.assertIn("        stop_fake_channel()\n        edit('content.json', lambda c: scenario_content_config(c, content_known, False))\n    lines = ", source)

    def test_the_video_operator_file_names_only_the_mock_site_and_runs_the_stand_in_inside_bubblewrap(self):
        site = {'id': 'MOCK', 'patterns': ['^https://video\\.mock\\.invalid/v/(?<id>[A-Za-z0-9]+)$']}
        config = sa.video_scenario_config(site, ROOT / '.local/opt/companion/bin/node', ROOT / 'tools', ROOT / '.local/opt/companion')
        self.assertEqual(config, {
            'schemaVersion': 1, 'ytdlp': [str(ROOT / '.local/opt/companion/bin/node'), str(ROOT / 'tools/fake-ytdlp.mjs')], 'ffmpeg': [str(ROOT / '.local/opt/companion/bin/node'), str(ROOT / 'tools/fake-ffmpeg.mjs')],
            'sandbox': {'kind': 'bwrap', 'bwrap': '/usr/bin/bwrap', 'readOnly': [str(ROOT / '.local/opt/companion'), str(ROOT / 'tools')]}, 'sites': [site]})
        # Nothing of the data root is among what the sandbox may read.
        self.assertFalse(any('companion-world-v1' in entry for entry in config['sandbox']['readOnly']))
        source = (HERE / 'staging-agent.py').read_text()
        self.assertIn("    scenario_video_config(release, True)\n", source)
        # Removed again in the `finally` of the replay: production never has a MOCK site.
        self.assertIn("        scenario_video_config(release, False)\n        stop_fake_channel()\n", source)
        self.assertIn("'deploy/staging/fake-ytdlp.mjs': 'fake-ytdlp.mjs'", (HERE / 'run.mjs').read_text())
        self.assertIn("'deploy/staging/fake-ffmpeg.mjs': 'fake-ffmpeg.mjs'", (HERE / 'run.mjs').read_text())

    def test_the_made_up_cookie_jar_is_private_while_replaying_and_only_it_is_removed_afterwards(self):
        # The same text as fake-ytdlp.mjs MOCK_COOKIES (what the local replay writes).
        fake = (HERE / 'fake-ytdlp.mjs').read_text()
        self.assertIn(json.dumps(sa.MOCK_VIDEO_COOKIES.rstrip('\n'), ensure_ascii=False).replace('"', "'"), fake.replace('"', "'"))
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / 'operator').mkdir(mode=0o700)
            saved, sa.BASE = sa.BASE, base
            self.addCleanup(setattr, sa, 'BASE', saved)
            target = base / 'operator/secrets/video-cookies.txt'
            sa.scenario_video_cookies(True)
            self.assertEqual((target.read_text(), target.stat().st_mode & 0o777, target.parent.stat().st_mode & 0o777), (sa.MOCK_VIDEO_COOKIES, 0o600, 0o700))
            sa.scenario_video_cookies(False)
            self.assertFalse(target.exists())
            # Anything else there (it never is on staging) is neither overwritten nor removed.
            target.write_text('# Netscape HTTP Cookie File\nsomething else\n')
            sa.scenario_video_cookies(True)
            sa.scenario_video_cookies(False)
            self.assertEqual(target.read_text(), '# Netscape HTTP Cookie File\nsomething else\n')

    def test_the_second_channel_gets_its_own_credential_executor_and_the_explicit_switch(self):
        config = {'credentials': [{'hash': 'a' * 64, 'role': 'capability', 'capabilityId': 'qq'}, {'hash': 'old', 'role': 'capability', 'capabilityId': 'mock'}],
                  'capabilities': [{'id': 'qq', 'policy': 'conversation.v1'}], 'operator': {'origins': []}}
        once = sa.mock_authority_config(json.loads(json.dumps(config)), 'b' * 64)
        self.assertEqual(once['credentials'], [config['credentials'][0], {'hash': 'b' * 64, 'role': 'capability', 'capabilityId': 'mock'}])
        self.assertEqual(once['capabilities'], [{'id': 'qq', 'policy': 'conversation.v1'}, {'id': 'mock', 'policy': 'conversation.v1'}])
        self.assertIs(once['operator']['allowTestChannels'], True)
        # The diary trigger is its own switch, written for every replay.
        self.assertNotIn('allowDiaryTrigger', once['operator'])
        self.assertEqual(sa.scenario_authority_config({'operator': {'origins': []}}), {'operator': {'origins': [], 'allowDiaryTrigger': True}})
        self.assertIn("    second_channel = prepare_mock_channel(release)\n    edit('authority.json', scenario_authority_config)\n", (HERE / 'staging-agent.py').read_text())
        self.assertEqual(sa.mock_authority_config(json.loads(json.dumps(once)), 'b' * 64), once)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'mock-channel'
            root.mkdir()
            (root / 'caller.token').write_text('MOCK-caller-token\n')
            conversation = {'socketPath': '/base/ipc/conversation/execute.sock', 'callerTokenHash': 'c' * 64, 'sessionsDir': '/base/conversation-data/sessions',
                            'authority': {'socketPath': '/base/ipc/authority/authority.sock', 'tokenFile': '/base/qq-worker/capability.token'}, 'gateway': {'socketPath': '/g', 'tokenFile': '/t'}}
            executor = sa.mock_executor_config(conversation, root)
            # Same keys as the release's executor configuration; nothing of the QQ executor is shared but Authority's and the gateway's sockets.
            self.assertEqual(sorted(executor), sorted(conversation))
            self.assertEqual(executor['authority'], {'socketPath': '/base/ipc/authority/authority.sock', 'tokenFile': str(root / 'capability.token')})
            self.assertEqual(executor['gateway'], conversation['gateway'])
            self.assertEqual(executor['callerTokenHash'], hashlib.sha256(b'MOCK-caller-token').hexdigest())
            for key in ('socketPath', 'sessionsDir'):
                self.assertNotEqual(executor[key], conversation[key])
        source = (HERE / 'staging-agent.py').read_text()
        self.assertIn("'--mock-control', str(mock_control)", source)
        self.assertIn('second_channel = prepare_mock_channel(release)', source)

    def test_a_release_with_ops_config_keys_is_asked_and_an_older_one_is_searched_as_source(self):
        with tempfile.TemporaryDirectory() as root:
            release = Path(root)
            (release / 'capabilities/media').mkdir(parents=True)
            (release / 'capabilities/media/main.mjs').write_text('cfg.allowRawSmallPng ?? false')
            self.assertIsNone(sa.config_keys(release))
            self.assertEqual(sa.release_knows(None, 'content.json', release, 'capabilities/media/main.mjs'), 'cfg.allowRawSmallPng ?? false')
            keys = {'content.json': frozenset(['sharpModule'])}
            self.assertEqual(sa.release_knows(keys, 'content.json', release, 'capabilities/media/main.mjs'), frozenset(['sharpModule']))
        config = {'onebotPort': sa.ONEBOT_PORT}
        self.assertEqual(sa.scenario_bridge_config(dict(config), frozenset(['onebotPort', 'initiationPollMs', 'pacing'])), {**config, 'initiationPollMs': 3000, 'pacing': sa.SCENARIO_PACING})
        self.assertEqual(sa.scenario_bridge_config(dict(config), frozenset(['onebotPort'])), config)
        self.assertEqual(sa.scenario_content_config({'sharpModule': '/x'}, frozenset(['allowRawSmallPng']), True), {'sharpModule': '/x', 'allowRawSmallPng': True})
        self.assertEqual(sa.scenario_content_config({'sharpModule': '/x'}, frozenset(['sharpModule']), True), {'sharpModule': '/x'})
        # A key name is not found inside another one's text once the release lists its keys.
        self.assertFalse(sa.knows(frozenset(['pacing.burstQuietMs']), 'pacing'))

    def test_the_bridge_polls_faster_only_when_the_release_knows_the_setting(self):
        config = {'onebotPort': sa.ONEBOT_PORT}
        self.assertEqual(sa.scenario_bridge_config(dict(config), "cfg.onebotPort"), config)
        self.assertEqual(sa.scenario_bridge_config(dict(config), "cfg.initiationPollMs ?? INITIATION_POLL_MS"), {**config, 'initiationPollMs': 3000})
        self.assertTrue(1000 <= sa.INITIATION_POLL_MS <= 600000)
        self.assertEqual(sa.scenario_bridge_config(dict(config), "const pacing = pacingFrom(cfg.pacing);"), {**config, 'pacing': sa.SCENARIO_PACING})
        source = (HERE / 'staging-agent.py').read_text()
        self.assertIn("edit('qq-bridge.json', lambda c: scenario_bridge_config(c, bridge_known))", source)
        self.assertIn("reset_initiations(BASE / 'authority-data/authority.sqlite')", source)
        self.assertIn("(BASE / 'media-data/jobs.json').unlink(missing_ok=True)", source)
        self.assertIn("(BASE / 'media-data/describe-cache.json').unlink(missing_ok=True)", source)
        self.assertIn("shutil.rmtree(BASE / 'media-data/stickers')", source)


if __name__ == '__main__':
    unittest.main()


class GroupRollbackTests(unittest.TestCase):
    ROWS = [
        {'streamId': 'qq:999900000001:private:999900000002', 'audience': 'private', 'messages': 9},
        {'streamId': 'qq:999900000001:group:999900009002', 'audience': 'shared', 'messages': 12, 'group': True, 'enabled': True},
        {'streamId': 'qq:999900000001:group:999900009004', 'audience': 'shared', 'messages': 30, 'group': True, 'enabled': False},
        {'streamId': 'mock:shared:MOCK-ROOM', 'audience': 'shared', 'messages': 2},
    ]

    def test_group_conversations_are_found_whether_or_not_the_release_marks_them(self):
        expected = {'qq:999900000001:group:999900009002': 12, 'qq:999900000001:group:999900009004': 30}
        self.assertEqual(sa.group_rows(self.ROWS), expected)
        # An older release lists the same conversations without the `group` and `enabled` marks.
        self.assertEqual(sa.group_rows([{key: value for key, value in row.items() if key not in ('group', 'enabled')} for row in self.ROWS]), expected)
        self.assertEqual(sa.group_rows([]), {})

    def test_the_groups_carried_over_the_rollback_need_one_that_is_enabled(self):
        original = sa.operator
        try:
            sa.operator = lambda method, route, body=None: self.ROWS
            carried = []
            self.assertRegex(sa.group_carry(carried), r'^2 group conversation\(s\), 1 enabled, 42 recorded line\(s\)$')
            self.assertEqual(carried, [{'groups': sa.group_rows(self.ROWS), 'enabled': ['qq:999900000001:group:999900009002']}])
            sa.operator = lambda method, route, body=None: [dict(row, enabled=False) for row in self.ROWS]
            with self.assertRaisesRegex(RuntimeError, 'no enabled group conversation'):
                sa.group_carry([])
            # Under the from-release: a group conversation that is gone, or has other lines, fails the step.
            sa.operator = lambda method, route, body=None: self.ROWS[:2]
            with self.assertRaisesRegex(RuntimeError, 'group conversations under the from-release: 1 with 12'):
                sa.group_after_rollback(None, carried[0])
            with self.assertRaisesRegex(RuntimeError, 'no group conversation was carried'):
                sa.group_after_rollback(None, None)
        finally:
            sa.operator = original

    def test_a_replay_starts_with_no_group_turns_counted_for_the_day(self):
        source = (HERE / 'staging-agent.py').read_text()
        self.assertIn("for key in ('budgetNotice', 'groupTurns') if state.pop(key, None) is not None", source)
