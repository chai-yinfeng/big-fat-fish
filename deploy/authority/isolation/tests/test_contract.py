"""Portable launcher contract tests; real namespace tests live in probe.py."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('isolation_launch', ROOT / 'launch.py')
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='companion-isolation-contract-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for part in ['base/authority-data', 'base/ipc/authority', 'base/ipc/operator',
                     'base/ipc/model-control', 'base/ipc/qq-control', 'base/ipc/model',
                     'base/operator', 'base/dsh-config', 'base/conversation-data',
                     'release', 'runtime', 'ops']:
            (self.root / part).mkdir(parents=True, exist_ok=True)
        (self.root / 'base/operator/authority.json').write_text('{}')
        (self.root / 'base/dsh-config/model-gateway.token').write_text('synthetic\n')
        self.parameters = [str(self.root / p) for p in ['base', 'release', 'runtime', 'ops']]

    def command(self, role, arguments=()):
        return launch.build_command(role, *self.parameters, arguments)

    def mounts(self, command):
        return [(command[i], command[i + 1], command[i + 2])
                for i in range(len(command)) if command[i] in ('--bind', '--ro-bind')]

    def test_required_namespace_and_environment_policy(self):
        for role in ['authority']:
            command = self.command(role)
            for flag in ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc',
                         '--unshare-uts', '--disable-userns', '--new-session', '--clearenv']:
                self.assertIn(flag, command)
            self.assertNotIn('--share-net', command)
            self.assertNotIn('--preserve-fds', command)
            self.assertEqual(command[command.index('--cap-drop') + 1], 'ALL')
            destinations = [m[2] for m in self.mounts(command)]
            self.assertNotIn('/proc', destinations)
            self.assertNotIn('/run', destinations)
            self.assertNotIn('/etc', destinations)
            self.assertNotIn(str(Path.home()), destinations)

    def test_node_arch_selects_official_archive_name(self):
        self.assertEqual(launch.node_arch('aarch64'), 'arm64')
        self.assertEqual(launch.node_arch('x86_64'), 'x64')
        with self.assertRaises(ValueError):
            launch.node_arch('riscv64')
        self.assertEqual(launch.NODE, '/opt/companion/runtime/node-v24.22.2-linux-' + launch.node_arch() + '/bin/node')
        self.assertTrue(self.command('authority')[self.command('authority').index('PATH') + 1].startswith(launch.NODE_HOME + '/bin:'))

    def test_authority_mounts_never_include_capability_or_admin(self):
        command = self.command('authority')
        sources = [m[1] for m in self.mounts(command)]
        self.assertNotIn(str(self.root / 'base/dsh-config'), sources)
        self.assertNotIn(str(self.root / 'base/conversation-data'), sources)
        self.assertNotIn(str(self.root / 'base/operator'), sources)
        self.assertNotIn(str(self.root / 'ops'), sources)
        self.assertIn(('--ro-bind', str(self.root / 'base/operator/authority.json'), '/authority/config.json'), self.mounts(command))
        self.assertEqual(command[-4:], [launch.NODE, '/opt/companion/release/authority/src/main.js', '--config', '/authority/config.json'])

    def test_no_missing_mount_creation_or_unknown_roles(self):
        with self.assertRaises(ValueError):
            self.command('authority', ['--arbitrary'])
        for role in ['capability', 'dsh', 'unknown']:
            with self.assertRaises(ValueError):
                self.command(role)
        with self.assertRaises(FileNotFoundError):
            launch.build_command('authority', str(self.root / 'missing'), *self.parameters[1:])

    def test_main_closes_ambient_handles_and_sterilizes_exec_environment(self):
        class ExecCaptured(Exception):
            pass
        for role, first in [('authority', 3)]:
            argv = ['launch.py']
            for flag, value in zip(['--base', '--release', '--runtime', '--ops'], self.parameters):
                argv += [flag, value]
            argv += [role]
            with patch('sys.argv', argv), patch.object(launch.os, 'closerange') as close, patch.object(launch.os, 'execve', side_effect=ExecCaptured) as execute:
                with self.assertRaises(ExecCaptured):
                    launch.main()
                close.assert_called_once_with(first, 1048576)
                self.assertEqual(execute.call_args.args[2], {'PATH': '/usr/bin:/bin'})

    def test_units_have_no_dsh_runtime_and_conversation_is_hardened(self):
        units = {p.name: p.read_text() for p in (ROOT / 'units').iterdir()}
        self.assertFalse([name for name in units if 'dsh' in name])
        self.assertNotIn('3081', ''.join(units.values()))
        conversation = units['companion-conversation.service']
        for line in ['Requires=companion-authority.service companion-model.service', 'NoNewPrivileges=true', 'ProtectSystem=strict',
                     'ReadWritePaths=%h/.local/share/companion-world-v1/conversation-data %h/.local/share/companion-world-v1/ipc/conversation',
                     'PrivateNetwork=true', 'RestrictAddressFamilies=AF_UNIX']:
            self.assertIn(line, conversation)
        self.assertNotIn('bwrap', conversation)
        self.assertIn('Requires=companion-authority.service companion-conversation.service', units['companion-qq.service'])
        self.assertNotIn('ExecStartPre', units['companion-qq.service'])

if __name__ == '__main__':
    unittest.main()
