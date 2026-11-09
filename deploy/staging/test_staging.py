"""Synthetic tests for the staging agent: unit transform, reset guard, companion-deploy reuse. No host access."""
import importlib.machinery
import importlib.util
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
            self.assertNotRegex(text, r'\b(3001|3082|6099)\b', name)
            self.assertNotRegex(text, r'\bcompanion-(?!staging-)[A-Za-z0-9-]+\.(service|socket)\b', name)
            self.assertNotIn('/home/companion', text, name)
            if '[Service]' in text:
                self.assertIn('Environment=HOME=%s\n' % ROOT, text, name)
        self.assertIn('ListenStream=127.0.0.1:13082', units['companion-staging-world-public.socket'])
        self.assertIn('Sockets=companion-staging-world-public.socket', units['companion-staging-world-public.service'])
        self.assertIn('%s/.local/share/companion-world-v1/ipc/operator/operator.sock' % ROOT, units['companion-staging-world-public.service'])
        self.assertIn('Requires=companion-staging-authority.service companion-staging-conversation.service', units['companion-staging-qq.service'])
        self.assertIn('ExecStart=/usr/bin/python3 %s/src/companion/current/ops/isolation/launch.py authority' % ROOT, units['companion-staging-authority.service'])

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


if __name__ == '__main__':
    unittest.main()
