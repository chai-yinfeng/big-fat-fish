"""Portable launcher contract tests; real namespace tests live in probe.py."""
import importlib.util
import os
from pathlib import Path
import tempfile
import socket
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('isolation_launch', ROOT / 'launch.py')
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dsh-isolation-contract-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for part in ['base/authority-data', 'base/ipc/authority', 'base/ipc/operator',
                     'base/ipc/model-control', 'base/ipc/qq-control', 'base/ipc/model',
                     'base/operator', 'base/dsh-home', 'base/dsh-config', 'base/qq-worker',
                     'base/qq-inbox', 'release', 'runtime', 'ops']:
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
        for role in ['authority', 'capability', 'dsh']:
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
        self.assertNotIn(str(self.root / 'base/dsh-home'), sources)
        self.assertNotIn(str(self.root / 'base/operator'), sources)
        self.assertNotIn(str(self.root / 'ops'), sources)
        self.assertIn(('--ro-bind', str(self.root / 'base/operator/authority.json'), '/authority/config.json'), self.mounts(command))
        self.assertEqual(command[-4:], [launch.NODE, '/opt/companion/release/authority/src/main.js', '--config', '/authority/config.json'])

    def test_capability_mounts_do_not_include_authority_database_or_operator(self):
        command = self.command('capability')
        sources = [m[1] for m in self.mounts(command)]
        self.assertNotIn(str(self.root / 'base/authority-data'), sources)
        self.assertNotIn(str(self.root / 'base/operator'), sources)
        self.assertIn(('--ro-bind', str(self.root / 'base/ipc/authority'), '/run/companion'), self.mounts(command))
        self.assertIn(('--ro-bind', str(self.root / 'base/dsh-config'), '/home/companion/config'), self.mounts(command))
        self.assertEqual(command[-2:], [launch.NODE, '/opt/companion/ops/run-capability.mjs'])
        self.assertNotIn('LISTEN_PID', command)

    def test_initialization_preserves_profile_and_exact_cli_arguments(self):
        args = ['plugin', 'install', '/opt/companion/release/capability-bundle']
        command = self.command('dsh', args)
        self.assertEqual(command[-5:], [launch.NODE, launch.DSH, *args])
        self.assertEqual(list((self.root / 'base/dsh-home').iterdir()), [])
        self.assertFalse(any('host' in x.lower() and 'trusted' in x.lower() for x in command))

    def test_no_missing_mount_creation_or_unknown_roles(self):
        with self.assertRaises(ValueError):
            self.command('authority', ['--arbitrary'])
        with self.assertRaises(ValueError):
            self.command('capability', ['--arbitrary'])
        with self.assertRaises(ValueError):
            self.command('unknown')
        with self.assertRaises(FileNotFoundError):
            launch.build_command('authority', str(self.root / 'missing'), *self.parameters[1:])

    def test_main_closes_ambient_handles_and_sterilizes_exec_environment(self):
        class ExecCaptured(Exception):
            pass
        for role, first in [('authority', 3), ('dsh', 3), ('capability', 4)]:
            argv = ['launch.py']
            for flag, value in zip(['--base', '--release', '--runtime', '--ops'], self.parameters):
                argv += [flag, value]
            argv += [role]
            with patch('sys.argv', argv), patch.object(launch, 'check_activation') as activation, patch.object(launch.os, 'closerange') as close, patch.object(launch.os, 'execve', side_effect=ExecCaptured) as execute:
                with self.assertRaises(ExecCaptured):
                    launch.main()
                close.assert_called_once_with(first, 1048576)
                self.assertEqual(execute.call_args.args[2], {'PATH': '/usr/bin:/bin'})
                self.assertEqual(activation.call_count, int(role == 'capability'))

    def test_activation_rejects_wrong_pid_or_count(self):
        for env in [{}, {'LISTEN_FDS': '2', 'LISTEN_PID': str(os.getpid())},
                    {'LISTEN_FDS': '1', 'LISTEN_PID': str(os.getpid() + 1)}]:
            with patch.dict(os.environ, env, clear=True):
                with self.assertRaises(ValueError):
                    launch.check_activation()

    @unittest.skipUnless(sys.platform == 'linux', 'AF_UNIX SO_ACCEPTCONN is Linux-specific')
    def test_activation_accepts_only_named_listening_unix_socket(self):
        real_dup = os.dup
        for family in [socket.AF_UNIX, socket.AF_INET]:
            with socket.socket(family) as listener:
                listener.bind(str(self.root / 'activation.sock') if family == socket.AF_UNIX else ('127.0.0.1', 0))
                listener.listen()
                with patch.dict(os.environ, {'LISTEN_FDS': '1', 'LISTEN_PID': str(os.getpid())}, clear=True), patch.object(launch.os, 'dup', side_effect=lambda fd: real_dup(listener.fileno())), patch.object(launch.os, 'set_inheritable') as inherit:
                    if family == socket.AF_UNIX:
                        launch.check_activation()
                        inherit.assert_called_once_with(3, True)
                    else:
                        with self.assertRaises(ValueError):
                            launch.check_activation()
                        inherit.assert_not_called()

    def test_unit_fd_and_dependency_contract(self):
        internal = (ROOT / 'units/companion-dsh-internal.service').read_text()
        public = (ROOT / 'units/companion-dsh-public.service').read_text()
        self.assertIn('Sockets=companion-dsh-internal.socket', internal)
        self.assertNotIn('Sockets=companion-dsh-public.socket', internal)
        self.assertIn('Requires=companion-authority.service', internal)
        self.assertIn('Requires=companion-dsh-internal.socket', public)
        for name in ['companion-dsh-public.socket', 'companion-dsh-internal.socket']:
            self.assertIn('Accept=no', (ROOT / 'units' / name).read_text())


if __name__ == '__main__':
    unittest.main()
