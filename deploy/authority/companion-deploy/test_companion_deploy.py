"""Synthetic tests for companion-deploy: no root, systemd, network or VM.

systemctl, port probes, ownership and the confirmation prompt are faked; Git is
real, against a temporary file:// origin.
"""
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
UNITS = HERE.parent / 'isolation/units'
loader = importlib.machinery.SourceFileLoader('companion_deploy', str(HERE / 'companion-deploy'))
spec = importlib.util.spec_from_loader('companion_deploy', loader)
cd = importlib.util.module_from_spec(spec)
loader.exec_module(cd)


def git(cwd, *args):
    return subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True,
                          env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't',
                               'GIT_COMMITTER_EMAIL': 't@t', 'GIT_CONFIG_NOSYSTEM': '1'}).stdout.strip()


class FakeSystem(cd.System):
    def __init__(self, config):
        super().__init__(config)
        self.calls, self.said = [], []
        self.broken = set()  # release names whose authority service fails
        self.answer = True
        self.chowned = []

    def owner(self):
        return os.getuid(), os.getgid()

    def log_group(self):
        return 4  # adm on Ubuntu; chown itself is faked below

    def fchown(self, fd, uid, gid):
        self.chowned.append((fd, uid, gid))

    def running(self):
        link = self.config.releases / 'current'
        return os.readlink(link) if link.is_symlink() else None

    def systemctl(self, *args, check=True):
        self.calls.append(args)
        stdout = ''
        if args[0] == 'show':
            blocks = []
            for name in args[2:]:
                failed = name == 'companion-authority.service' and self.running() in self.broken
                blocks.append('Id=%s\nActiveState=%s\nNRestarts=0' % (name, 'failed' if failed else 'active'))
            stdout = '\n\n'.join(blocks) + '\n'
        return subprocess.CompletedProcess(args, 0, stdout, '')

    def listening(self, port):
        return True

    def sleep(self, seconds):
        pass

    def confirm(self, prompt):
        return self.answer

    def say(self, text):
        self.said.append(text)


class Fixture(unittest.TestCase):
    fresh = False  # True: a new host with no release, no units and no release/unit directories

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='companion-deploy-test-')
        self.addCleanup(self.cleanup, temp)
        self.root = Path(temp.name).resolve()
        home = self.root / 'home'
        home.mkdir()
        if not self.fresh:
            (home / 'src/companion').mkdir(parents=True)
            (home / '.config/systemd/user').mkdir(parents=True)
        self.config = cd.Config(home=home, state=self.root / 'state', log=self.root / 'deploy.log',
                                status=self.root / 'deploy.status.json',
                                origin='file://' + str(self.root / 'origin.git'), git_protocol='file')
        self.system = FakeSystem(self.config)
        self.deployer = cd.Deployer(self.config, self.system)
        # Legacy layout: versioned dirs, units hard-coded to authority-0.10.0, no `current`.
        for legacy in () if self.fresh else ('authority-0.10.0', 'authority-0.9.0'):
            store = home / 'src/companion' / legacy / 'authority/src/store.js'
            store.parent.mkdir(parents=True)
            store.write_text('export const SCHEMA_VERSION = 2;\n')
        self.legacy_units = {}
        for unit in [] if self.fresh else sorted(UNITS.iterdir()):
            text = unit.read_text().replace('%h/src/companion/current/', '%h/src/companion/authority-0.10.0/')
            (self.config.units / unit.name).write_text(text)
            self.legacy_units[unit.name] = text
        # Origin with a main history and an unpublished side commit.
        work = self.root / 'checkout'
        work.mkdir()
        git(work, 'init', '-q', '-b', 'main')
        self.commits = []
        for index in range(6):
            (work / 'f').write_text(str(index))
            git(work, 'add', 'f')
            git(work, 'commit', '-q', '-m', 'release %d' % index)
            self.commits.append(git(work, 'rev-parse', 'HEAD'))
        git(work, 'checkout', '-q', '-b', 'side')
        (work / 'f').write_text('side')
        git(work, 'commit', '-qam', 'unpublished')
        self.unpublished = git(work, 'rev-parse', 'HEAD')
        git(work, 'checkout', '-q', 'main')
        git(self.root, 'clone', '-q', '--bare', str(work), str(self.root / 'origin.git'))
        subprocess.run(['git', '--git-dir', str(self.root / 'origin.git'), 'fetch', '-q', str(work), 'side:side'], check=True)

    def cleanup(self, temp):
        for current, _dirs, _files in os.walk(self.root):
            os.chmod(current, 0o700)
        temp.cleanup()

    def release(self, revision, version='0.11.0', schema=2, mutate=None):
        """Build a release tree and tarball the way build-release + stage-release do."""
        name = 'authority-%s-%s' % (version, revision[:12])
        tree = self.root / 'build' / name
        files = {'authority/src/store.js': 'export const SCHEMA_VERSION = %d;\n' % schema,
                 'ops/isolation/launch.py': '#!/usr/bin/python3\n', 'package.json': '{}\n'}
        for unit in UNITS.iterdir():
            files['ops/isolation/units/' + unit.name] = unit.read_text()
        for relative, text in files.items():
            (tree / relative).parent.mkdir(parents=True, exist_ok=True)
            (tree / relative).write_text(text)
        manifest = {'schemaVersion': 2, 'productVersion': version, 'releaseName': name, 'sourceRevision': revision,
                    'files': {r: hashlib.sha256(t.encode()).hexdigest() for r, t in sorted(files.items())},
                    'executables': ['ops/isolation/launch.py']}
        (tree / 'source-manifest.json').write_text(json.dumps(manifest))
        if mutate:
            mutate(tree)
        inbox = self.root / 'inbox'
        inbox.mkdir(exist_ok=True)
        tarball = inbox / (name + '.tar.gz')
        with tarfile.open(tarball, 'w:gz') as archive:
            archive.add(tree, arcname=name)
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        Path(str(tarball) + '.sha256').write_text('%s  %s\n' % (digest, tarball.name))
        shutil.rmtree(self.root / 'build')
        return tarball, name

    def current(self):
        return os.readlink(self.config.releases / 'current')

    def units(self):
        return {p.name: p.read_text() for p in self.config.units.iterdir() if cd.UNIT_PATTERN.match(p.name)}


class ExtractTests(Fixture):
    def archive(self, add):
        tarball = self.root / 'bad.tar.gz'
        with tarfile.open(tarball, 'w:gz') as archive:
            add(archive)
        return tarball

    def entry(self, name, kind=tarfile.REGTYPE, data=b'x', mode=0o644, link=''):
        info = tarfile.TarInfo(name)
        info.type, info.mode, info.linkname = kind, mode, link
        info.size = len(data) if kind == tarfile.REGTYPE else 0
        return info, io.BytesIO(data) if kind == tarfile.REGTYPE else None

    def rejects(self, *entries):
        tarball = self.archive(lambda a: [a.addfile(*self.entry(*e[:1], **e[1])) for e in entries])
        target = self.root / 'out'
        shutil.rmtree(target, ignore_errors=True)
        target.mkdir()
        with self.assertRaises(cd.DeployError):
            cd.safe_extract(tarball, target)
        self.assertEqual(list(target.rglob('*')), [])

    def test_rejects_unsafe_members(self):
        top = 'authority-0.11.0-' + 'a' * 12
        self.rejects(('/etc/passwd', {}))
        self.rejects((top + '/../../escape', {}))
        self.rejects((top + '/link', {'kind': tarfile.SYMTYPE, 'link': '/etc/shadow'}))
        self.rejects((top + '/link', {'kind': tarfile.SYMTYPE, 'link': 'inside'}))
        self.rejects((top + '/hard', {'kind': tarfile.LNKTYPE, 'link': '/etc/shadow'}))
        self.rejects((top + '/dev', {'kind': tarfile.CHRTYPE}))
        self.rejects((top + '/fifo', {'kind': tarfile.FIFOTYPE}))
        self.rejects((top + '/suid', {'mode': 0o4755}))
        self.rejects((top + '/sgid', {'mode': 0o2755}))
        self.rejects((top + '/a', {}), ('authority-0.11.0-' + 'b' * 12 + '/b', {}))
        self.rejects(('not-a-release/a', {}))
        self.rejects((top + '/a', {}), (top + '/a', {}))

    def test_extract_ignores_archive_modes(self):
        top = 'authority-0.11.0-' + 'a' * 12
        tarball = self.archive(lambda a: a.addfile(*self.entry(top + '/x', mode=0o777)))
        (self.root / 'out').mkdir()
        self.assertEqual(cd.safe_extract(tarball, self.root / 'out'), top)
        self.assertEqual((self.root / 'out' / top / 'x').stat().st_mode & 0o777, 0o600)


class DeployTests(Fixture):
    def test_repository_units_follow_current_not_a_version(self):
        for unit in UNITS.iterdir():
            self.assertNotRegex(unit.read_text(), r'src/companion/authority-')

    def test_manifest_mismatch_extra_and_missing_files_are_refused(self):
        for mutate, message in [(lambda t: (t / 'package.json').write_text('{"evil":1}\n'), 'sha256 mismatch'),
                                (lambda t: (t / 'extra.js').write_text(''), 'extra'),
                                (lambda t: (t / 'package.json').unlink(), 'missing')]:
            tarball, name = self.release(self.commits[1], mutate=mutate)
            with self.assertRaisesRegex(cd.DeployError, message):
                self.deployer.deploy(tarball)
            self.assertFalse((self.config.releases / name).exists())
            shutil.rmtree(self.root / 'inbox')
        self.assertEqual(self.units(), self.legacy_units)
        self.assertEqual(self.system.calls, [])

    def test_checksum_mismatch_is_refused(self):
        tarball, _ = self.release(self.commits[1])
        Path(str(tarball) + '.sha256').write_text('0' * 64 + '  x\n')
        with self.assertRaisesRegex(cd.DeployError, 'sha256'):
            self.deployer.deploy(tarball)

    def test_unpublished_revision_is_refused(self):
        tarball, name = self.release(self.unpublished)
        with self.assertRaisesRegex(cd.DeployError, 'not contained in origin main'):
            self.deployer.deploy(tarball)
        self.assertFalse((self.config.releases / name).exists())
        self.assertFalse((self.config.releases / 'current').is_symlink())
        self.assertEqual(self.system.calls, [])

    def test_schema_change_is_refused(self):
        tarball, _ = self.release(self.commits[1], schema=3)
        with self.assertRaisesRegex(cd.DeployError, 'schema 2 -> 3'):
            self.deployer.deploy(tarball)

    def test_declined_confirmation_changes_nothing(self):
        tarball, name = self.release(self.commits[1])
        self.system.answer = False
        with self.assertRaisesRegex(cd.DeployError, 'declined'):
            self.deployer.deploy(tarball)
        self.assertFalse((self.config.releases / name).exists())
        self.assertEqual(self.units(), self.legacy_units)

    def test_first_deploy_then_rollback_restores_legacy_units(self):
        tarball, name = self.release(self.commits[1])
        self.assertEqual(self.deployer.deploy(tarball), name)
        self.assertEqual(self.current(), name)
        self.assertTrue(all('src/companion/current/' in t or 'src/companion' not in t for t in self.units().values()))
        release = self.config.releases / name
        self.assertEqual(release.stat().st_mode & 0o777, 0o555)
        self.assertEqual((release / 'package.json').stat().st_mode & 0o777, 0o444)
        self.assertEqual((release / 'ops/isolation/launch.py').stat().st_mode & 0o777, 0o555)
        self.assertIn(('daemon-reload',), self.system.calls)
        started = [c for c in self.system.calls if c[0] == 'start'][-1]
        self.assertIn('companion-qq.service', started)
        self.assertIn('companion-conversation.service', started)
        self.assertIn('companion-world-public.socket', started)
        self.assertNotIn('companion-world-public.service', started)  # socket activated
        with self.assertRaisesRegex(cd.DeployError, 'already installed'):
            self.deployer.deploy(tarball)

        self.assertEqual(self.deployer.rollback(), 'authority-0.10.0')
        self.assertEqual(self.units(), self.legacy_units)
        self.assertEqual(self.current(), 'authority-0.10.0')
        # Rolling back again returns to the new release with its own units.
        self.assertEqual(self.deployer.rollback(), name)
        self.assertEqual(self.current(), name)
        self.assertNotEqual(self.units(), self.legacy_units)
        log = [json.loads(line)['action'] for line in self.config.log.read_text().splitlines()]
        self.assertEqual(log, ['deploy', 'rollback', 'rollback'])

    def test_failed_health_check_restores_previous_release_and_units(self):
        tarball, name = self.release(self.commits[1])
        self.system.broken.add(name)
        with self.assertRaisesRegex(cd.DeployError, 'failed health check; restored authority-0.10.0'):
            self.deployer.deploy(tarball)
        self.assertEqual(self.current(), 'authority-0.10.0')
        self.assertEqual(self.units(), self.legacy_units)
        state = json.loads(self.config.state_file.read_text())
        self.assertEqual(state['current']['release'], 'authority-0.10.0')
        self.assertIsNone(state['previous'])
        self.assertIn('deploy-failed', self.config.log.read_text())

    def test_failed_start_command_also_restores(self):
        tarball, name = self.release(self.commits[1])
        original = self.system.systemctl
        def systemctl(*args, check=True):
            if args[0] == 'start' and self.system.running() == name:
                raise cd.DeployError('systemctl start failed: synthetic')
            return original(*args, check=check)
        self.system.systemctl = systemctl
        with self.assertRaisesRegex(cd.DeployError, 'restored authority-0.10.0'):
            self.deployer.deploy(tarball)
        self.assertEqual(self.units(), self.legacy_units)
        self.assertEqual(self.current(), 'authority-0.10.0')

    def mode(self, path):
        return path.stat().st_mode & 0o777

    def test_log_and_status_are_root_adm_0640_and_state_stays_private(self):
        self.config.log.write_text('')
        os.chmod(self.config.log, 0o600)  # an existing file with the wrong mode is fixed on append
        tarball, name = self.release(self.commits[1])
        self.deployer.deploy(tarball)
        self.assertEqual(self.mode(self.config.log), 0o640)
        self.assertEqual(self.mode(self.config.status), 0o640)
        self.assertEqual(self.mode(self.config.state_file), 0o600)
        self.assertTrue(self.system.chowned)
        self.assertTrue(all(uid == 0 and gid == 4 for _fd, uid, gid in self.system.chowned))
        status = json.loads(self.config.status.read_text())
        self.assertEqual((status['current'], status['previous']), (name, 'authority-0.10.0'))
        self.assertEqual(status['last']['action'], 'deploy')
        self.assertTrue(status['last']['ok'])
        self.assertEqual(sorted(status), ['current', 'last', 'previous', 'updatedAt'])
        before = len(self.system.chowned)
        self.deployer.rollback()
        self.assertGreater(len(self.system.chowned), before)  # ownership reasserted on every write
        status = json.loads(self.config.status.read_text())
        self.assertEqual((status['current'], status['last']['action']), ('authority-0.10.0', 'rollback'))

    def test_status_records_refused_and_failed_deploys(self):
        tarball, _ = self.release(self.unpublished)
        with self.assertRaises(cd.DeployError):
            self.deployer.deploy(tarball)
        status = json.loads(self.config.status.read_text())
        self.assertFalse(status['last']['ok'])
        self.assertIn('not contained in origin main', status['last']['detail'])
        self.assertEqual(status['current'], 'authority-0.10.0')
        self.assertEqual(self.mode(self.config.status), 0o640)
        shutil.rmtree(self.root / 'inbox')
        tarball, name = self.release(self.commits[1])
        self.system.broken.add(name)
        with self.assertRaises(cd.DeployError):
            self.deployer.deploy(tarball)
        status = json.loads(self.config.status.read_text())
        self.assertFalse(status['last']['ok'])
        self.assertEqual(status['current'], 'authority-0.10.0')

    def test_log_refuses_a_non_regular_file(self):
        os.mkfifo(self.config.log)
        with self.assertRaises(OSError):
            self.deployer.log('x')

    def test_failed_second_deploy_restores_first(self):
        first, first_name = self.release(self.commits[1])
        self.deployer.deploy(first)
        first_units = self.units()
        second, second_name = self.release(self.commits[2])
        self.system.broken.add(second_name)
        with self.assertRaises(cd.DeployError):
            self.deployer.deploy(second)
        self.assertEqual(self.current(), first_name)
        self.assertEqual(self.units(), first_units)
        self.assertEqual(self.deployer.rollback(), 'authority-0.10.0')
        self.assertEqual(self.units(), self.legacy_units)

    def test_retention_keeps_three_newest_current_previous_and_legacy(self):
        names = []
        for commit in self.commits[1:6]:
            tarball, name = self.release(commit)
            self.deployer.deploy(tarball)
            names.append(name)
        present = sorted(p.name for p in self.config.releases.iterdir() if not p.is_symlink())
        self.assertEqual(present, sorted(['authority-0.10.0', 'authority-0.9.0', *names[2:]]))
        # An old previous release survives even when it is not among the newest three.
        state = json.loads(self.config.state_file.read_text())
        state['previous'] = {'release': names[2], 'snapshot': 'x'}
        ages = {names[2]: 0, names[3]: 1, names[4]: 50}
        for item in state['installed']:
            item['at'] = ages[item['release']]
        for letter, at in (('e', 90), ('f', 100)):
            state['installed'].append({'release': 'authority-0.11.0-' + letter * 12, 'at': at})
            (self.config.releases / ('authority-0.11.0-' + letter * 12)).mkdir()
        removed = self.deployer.retain(state)
        self.assertEqual(removed, [names[3]])
        self.assertTrue((self.config.releases / names[2]).is_dir())
        self.assertTrue((self.config.releases / 'authority-0.10.0').is_dir())


class HealthTests(Fixture):
    def test_only_the_remaining_console_port_is_required(self):
        self.assertEqual(cd.PORTS, (3082,))
        probed = []
        self.system.listening = lambda port: probed.append(port) or port == 3082
        self.assertEqual(self.deployer.health(self.deployer.installed_units()), [])
        self.assertEqual(probed, [3082])


class FreshHostTests(Fixture):
    fresh = True

    def test_first_deploy_installs_without_starting_then_start_checks_health(self):
        self.assertIsNone(self.deployer.active_release())
        tarball, name = self.release(self.commits[1], schema=7)  # no running schema to compare
        self.assertEqual(self.deployer.deploy(tarball), name)
        self.assertEqual(self.current(), name)
        for path in (self.config.releases, self.config.units):
            self.assertTrue(path.is_dir() and not path.is_symlink())
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        self.assertEqual(sorted(self.units()), sorted(p.name for p in UNITS.iterdir()))
        self.assertIn(('daemon-reload',), self.system.calls)
        self.assertFalse([c for c in self.system.calls if c[0] == 'start'])
        state = json.loads(self.config.state_file.read_text())
        self.assertEqual(state['current'], {'release': name})
        self.assertIsNone(state['previous'])
        status = json.loads(self.config.status.read_text())
        self.assertEqual((status['current'], status['previous'], status['last']['ok']), (name, None, True))
        with self.assertRaisesRegex(cd.DeployError, 'no previous release'):
            self.deployer.rollback()

        self.assertEqual(self.deployer.start(), name)
        started = [c for c in self.system.calls if c[0] == 'start'][-1]
        self.assertIn('companion-conversation.service', started)
        self.assertIn('companion-world-public.socket', started)
        log = [json.loads(line)['action'] for line in self.config.log.read_text().splitlines()]
        self.assertEqual(log, ['deploy-first', 'start'])

        # The next release is a normal deploy with rollback to the first one.
        second, second_name = self.release(self.commits[2], schema=7)
        self.assertEqual(self.deployer.deploy(second), second_name)
        self.assertEqual(self.deployer.rollback(), name)

    def test_unhealthy_start_stops_services_again(self):
        tarball, name = self.release(self.commits[1])
        self.deployer.deploy(tarball)
        self.system.broken.add(name)
        with self.assertRaisesRegex(cd.DeployError, 'not healthy'):
            self.deployer.start()
        self.assertEqual(self.system.calls[-2][0], 'stop')
        self.assertFalse(json.loads(self.config.status.read_text())['last']['ok'])
        self.assertEqual(self.current(), name)

    def test_declined_first_install_changes_nothing(self):
        tarball, name = self.release(self.commits[1])
        self.system.answer = False
        with self.assertRaisesRegex(cd.DeployError, 'declined'):
            self.deployer.deploy(tarball)
        self.assertFalse((self.config.releases / name).exists())
        self.assertFalse((self.config.releases / 'current').is_symlink())
        self.assertEqual(self.units(), {})
        with self.assertRaisesRegex(cd.DeployError, 'no release is installed'):
            self.deployer.start()


if __name__ == '__main__':
    unittest.main()
