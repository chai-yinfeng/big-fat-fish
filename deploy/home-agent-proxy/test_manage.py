"""Synthetic, offline regressions for the private Mihomo manager."""

from contextlib import ExitStack, redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import urllib.request

try:
    import yaml
except ModuleNotFoundError:  # The helper needs PyYAML; home-agent has the system package.
    raise unittest.SkipTest("PyYAML not installed; run where python3 -c 'import yaml' works")


SPEC = importlib.util.spec_from_file_location("home_agent_proxy_manage", Path(__file__).with_name("manage.py"))
manage = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = manage
SPEC.loader.exec_module(manage)


SYNTHETIC_SECRET = "synthetic-secret-not-for-output"


def node(**overrides):
    value = {"name": "synthetic-provider-label", "type": "anytls", "server": "node.example.com",
             "port": 443, "password": SYNTHETIC_SECRET, "sni": "tls.example.com", "udp": True,
             "skip-cert-verify": False, "alpn": ["h2", "http/1.1"], "client-fingerprint": "chrome"}
    value.update(overrides)
    return value


def subscription(nodes=None, **root):
    return yaml.safe_dump({"proxies": [node()] if nodes is None else nodes, **root}).encode()


class Response(io.BytesIO):
    status = 200

    def __init__(self, data, headers=None):
        super().__init__(data)
        self.headers = headers or {}


class ProjectionSafetyTests(unittest.TestCase):
    def test_untrusted_root_is_removed_and_listener_policy_is_owned(self):
        value = manage.project_subscription(subscription(
            **{"mixed-port": 9090, "allow-lan": True, "bind-address": "0.0.0.0", "mode": "direct",
               "external-controller": "0.0.0.0:9091", "external-ui": "/private/ui", "secret": SYNTHETIC_SECRET,
               "tun": {"enable": True}, "dns": {"enable": True, "listen": "0.0.0.0:53"},
               "profile": {"store-selected": True}, "proxy-providers": {"evil": {"url": "http://invalid"}},
               "proxy-groups": [{"name": "ATTACKER", "type": "select", "proxies": ["DIRECT"]}],
               "rules": ["MATCH,DIRECT"]}))
        self.assertEqual(value["mixed-port"], 7890)
        self.assertIs(value["allow-lan"], False)
        self.assertEqual(value["bind-address"], "127.0.0.1")
        self.assertEqual(value["mode"], "rule")
        self.assertEqual(value["log-level"], "silent")
        self.assertIs(value["ipv6"], False)
        self.assertEqual(value["find-process-mode"], "off")
        self.assertEqual(value["tun"], {"enable": False})
        self.assertEqual(value["dns"], {"enable": False})
        self.assertEqual(value["profile"], {"store-selected": False, "store-fake-ip": False})
        for key in ("external-controller", "external-ui", "secret", "proxy-providers"):
            self.assertNotIn(key, value)
        self.assertNotIn("DIRECT", manage.encode(value).decode())
        self.assertEqual(value["proxy-groups"][0]["name"], "AUTO")
        self.assertEqual(value["proxy-groups"][0]["url"], "https://www.gstatic.com/generate_204")
        self.assertEqual(value["rules"][-1], "MATCH,REJECT")

    def test_only_inline_supported_nodes_are_projected_and_labels_are_synthetic(self):
        value = manage.project_subscription(subscription([node(), node(type="hysteria2")]))
        self.assertEqual([item["name"] for item in value["proxies"]], ["node-001", "node-002"])
        self.assertNotIn("synthetic-provider-label", manage.encode(value).decode())
        self.assertEqual(value["proxy-groups"][0]["proxies"], ["node-001", "node-002"])
        self.assertEqual(manage.counts(value), {"anytls": 1, "hysteria2": 1})
        for item in value["proxies"]:
            self.assertIs(item["skip-cert-verify"], False)

    def test_unsupported_fields_and_protocols_fail_closed(self):
        for field in ("dialer-proxy", "interface-name", "routing-mark", "obfs", "reality-opts", "tfo"):
            with self.subTest(field=field), self.assertRaises(manage.ProxyError) as failure:
                manage.project_subscription(subscription([node(**{field: "untrusted"})]))
            self.assertEqual(failure.exception.code, "unsupported_node_field")
        for protocol in ("socks5", "http", "direct", None):
            with self.subTest(protocol=protocol), self.assertRaises(manage.ProxyError) as failure:
                manage.project_subscription(subscription([node(type=protocol)]))
            self.assertEqual(failure.exception.code, "unsupported_node")

    def test_authorized_node_tls_policy_does_not_relax_unspecified_nodes(self):
        for requested in (True, False):
            with self.subTest(requested=requested):
                value = manage.project_subscription(subscription([node(**{"skip-cert-verify": requested})]))
                self.assertIs(value["proxies"][0]["skip-cert-verify"], requested)
        for invalid in ("false", 0, None):
            with self.subTest(invalid=invalid), self.assertRaises(manage.ProxyError) as failure:
                manage.project_subscription(subscription([node(**{"skip-cert-verify": invalid})]))
            self.assertEqual(failure.exception.code, "unsupported_node")
        without_setting = node()
        without_setting.pop("skip-cert-verify")
        value = manage.project_subscription(subscription([without_setting]))
        self.assertIs(value["proxies"][0]["skip-cert-verify"], False)

    def test_malformed_nodes_and_unsafe_yaml_are_refused(self):
        for item in (node(port=True), node(port="443"), node(port=0), node(password=[]),
                     node(server="node.example.com/escape"), node(alpn="h2"), node(udp="true")):
            with self.subTest(item=item), self.assertRaises(manage.ProxyError):
                manage.project_subscription(subscription([item]))
        for body in (b"!!python/object/apply:os.system ['echo bad']", b"proxies: []", b"proxies: {}",
                     b"proxy-providers: {}", b"null"):
            with self.subTest(body=body), self.assertRaises(manage.ProxyError):
                manage.project_subscription(body)

    def test_private_destination_rules_precede_proxy_and_resolve_hostnames(self):
        rules = manage.project_subscription(subscription())["rules"]
        for network in ("10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "192.168.0.0/16"):
            self.assertIn(f"IP-CIDR,{network},REJECT", rules[:-1])
        for network in ("::1/128", "fc00::/7", "fe80::/10"):
            self.assertIn(f"IP-CIDR6,{network},REJECT", rules[:-1])
        self.assertFalse(any("no-resolve" in rule or "DIRECT" in rule for rule in rules))

    def test_download_destinations_are_allowlisted_after_private_denials(self):
        rules = manage.project_subscription(subscription())["rules"]
        self.assertEqual(rules[-1], "MATCH,REJECT")
        for domain in ("docker.io", "github.com", "githubusercontent.com", "npmjs.org", "pypi.org"):
            rule = f"DOMAIN-SUFFIX,{domain},AUTO"
            self.assertIn(rule, rules)
            self.assertGreater(rules.index(rule), rules.index("IP-CIDR,127.0.0.0/8,REJECT"))
        self.assertFalse(any("deepseek" in rule or "wecom" in rule for rule in rules))


class FetchSafetyTests(unittest.TestCase):
    def test_unsafe_urls_are_rejected(self):
        urls = ("http://public.example.com/sub", "file:///etc/passwd", "https://localhost/sub",
                "https://127.0.0.1/sub", "https://127.1/sub", "https://0177.0.0.1/sub",
                "https://[::1]/sub", "https://100.64.0.1/sub", "https://192.168.1.2/sub",
                "https://router.local./sub", "https://host.ts.net/sub", "https://user:pass@example.com/sub",
                "https://example.com/sub#fragment", "https://example.com:0/sub", "https://example.com:99999/sub",
                "https://example.com/\nsecret", "https://example.com\\@127.0.0.1/sub")
        for url in urls:
            with self.subTest(url=url), self.assertRaises(manage.ProxyError) as failure:
                manage.validate_url(url.encode())
            self.assertEqual(failure.exception.code, "invalid_url")
        self.assertEqual(manage.validate_url(b"https://subscription.example.com/sub?token=synthetic\n"),
                         "https://subscription.example.com/sub?token=synthetic")

    def test_fetch_disables_inherited_proxies_and_requires_verified_tls(self):
        observed = {}

        def opener_factory(*handlers):
            proxy = next(handler for handler in handlers if isinstance(handler, urllib.request.ProxyHandler))
            https = next(handler for handler in handlers if isinstance(handler, urllib.request.HTTPSHandler))
            self.assertEqual(proxy.proxies, {})
            self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
            self.assertIs(https._context.check_hostname, True)
            self.assertTrue(any(isinstance(handler, manage.NoRedirect) for handler in handlers))
            opener = mock.Mock()
            opener.open.return_value = Response(b"proxies: []")
            observed["opener"] = opener
            return opener

        with mock.patch.dict(os.environ, {"HTTPS_PROXY": "http://synthetic.invalid:9999"}), \
                mock.patch.object(urllib.request, "build_opener", side_effect=opener_factory):
            self.assertEqual(manage.fetch_subscription("https://subscription.example.com/sub"), b"proxies: []")
        self.assertLessEqual(observed["opener"].open.call_args.kwargs["timeout"], manage.FETCH_SECONDS)

    def test_redirects_compressed_and_oversize_responses_are_refused(self):
        with self.assertRaises(manage.ProxyError):
            manage.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example.com")
        cases = [(b"", {"Content-Encoding": "gzip"}, "fetch_failed"),
                 (b"", {"Content-Length": str(manage.MAX_BODY + 1)}, "subscription_too_large"),
                 (b"x" * (manage.MAX_BODY + 1), {}, "subscription_too_large")]
        for body, headers, code in cases:
            opener = mock.Mock()
            opener.open.return_value = Response(body, headers)
            with self.subTest(code=code, headers=headers), \
                    mock.patch.object(urllib.request, "build_opener", return_value=opener), \
                    self.assertRaises(manage.ProxyError) as failure:
                manage.fetch_subscription("https://subscription.example.com/sub")
            self.assertEqual(failure.exception.code, code)


class ManagerSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        # Darwin's /var is itself a symlink; fixtures use its canonical, synthetic directory.
        self.paths = manage.Paths(Path(self.temporary.name).resolve())
        self.original = manage.encode(manage.project_subscription(subscription()))
        self.previous = manage.encode(manage.project_subscription(subscription([node(password="synthetic-older")])))
        with manage.PrivateDirectory(self.paths.config_dir, create=True) as config:
            config.write("subscription-url", b"https://subscription.example.com/sub?token=synthetic-private\n")
            config.write("config.json", self.original)
            config.write("config.previous.json", self.previous)
        with manage.PrivateDirectory(self.paths.state_dir, create=True):
            pass

    def patches(self, *, fetch=None, active=False, restart=None, validate=None):
        stack = ExitStack()
        stack.enter_context(mock.patch.object(
            manage, "fetch_subscription", return_value=subscription([node(password="synthetic-new")]),
            **({"side_effect": fetch} if fetch else {})))
        stack.enter_context(mock.patch.object(manage, "service_active", return_value=active))
        stack.enter_context(mock.patch.object(manage, "validate_candidate", side_effect=validate))
        restarted = stack.enter_context(mock.patch.object(manage, "restart_service", side_effect=restart))
        stack.enter_context(mock.patch.object(manage, "restore_service", side_effect=restart))
        stack.enter_context(mock.patch.object(manage, "verify_proxy"))
        return stack, restarted

    def assert_preserved(self):
        self.assertEqual((self.paths.config_dir / "config.json").read_bytes(), self.original)
        self.assertEqual((self.paths.config_dir / "config.previous.json").read_bytes(), self.previous)
        self.assertEqual(list(self.paths.config_dir.glob(".candidate-*")), [])

    def test_symlink_wrong_mode_hardlink_and_wrong_owner_reads_are_refused(self):
        secret = self.paths.config_dir / "subscription-url"
        target = self.paths.home / "synthetic-target"
        target.write_bytes(secret.read_bytes())
        target.chmod(0o600)
        secret.unlink()
        secret.symlink_to(target)
        with manage.PrivateDirectory(self.paths.config_dir) as config, self.assertRaises(manage.ProxyError):
            config.read("subscription-url")
        secret.unlink()
        os.link(target, secret)
        with manage.PrivateDirectory(self.paths.config_dir) as config, self.assertRaises(manage.ProxyError):
            config.read("subscription-url")
        secret.unlink()
        secret.write_bytes(b"https://subscription.example.com/sub")
        secret.chmod(0o644)
        with manage.PrivateDirectory(self.paths.config_dir) as config, self.assertRaises(manage.ProxyError):
            config.read("subscription-url")
        secret.chmod(0o600)
        uid = os.getuid()
        with manage.PrivateDirectory(self.paths.config_dir) as config, \
                mock.patch.object(os, "getuid", return_value=uid + 1), self.assertRaises(manage.ProxyError):
            config.read("subscription-url")

    def test_symlink_ancestor_and_open_directory_permissions_are_refused(self):
        link = self.paths.home / "synthetic-link"
        link.symlink_to(self.paths.config_dir, target_is_directory=True)
        with self.assertRaises(manage.ProxyError):
            manage.PrivateDirectory(link)
        self.paths.config_dir.chmod(0o755)
        with self.assertRaises(manage.ProxyError):
            manage.PrivateDirectory(self.paths.config_dir)

    @unittest.skipUnless(hasattr(os, "O_PATH"), "Linux path-only directory handles")
    def test_private_reads_do_not_require_listing_the_filesystem_root(self):
        original_open = os.open

        def root_listing_denied(path, flags, *args, **kwargs):
            if path == "/" and not flags & os.O_PATH:
                raise PermissionError("synthetic root-listing policy")
            return original_open(path, flags, *args, **kwargs)

        with mock.patch.object(manage.os, "open", side_effect=root_listing_denied), \
                manage.PrivateDirectory(self.paths.config_dir) as directory:
            self.assertEqual(directory.read("config.json"), self.original)

    def test_unsafe_url_file_never_fetches_and_preserves_good_config(self):
        (self.paths.config_dir / "subscription-url").chmod(0o644)
        stack, restarted = self.patches()
        with stack, self.assertRaises(manage.ProxyError) as failure:
            manage.update(self.paths)
        self.assertEqual(failure.exception.code, "unsafe_file")
        restarted.assert_not_called()
        self.assert_preserved()

    def test_only_one_update_can_hold_the_lock(self):
        stack, restarted = self.patches()
        with stack, manage.PrivateDirectory(self.paths.state_dir) as state, state.update_lock(), \
                self.assertRaises(manage.ProxyError) as failure:
            manage.update(self.paths)
        self.assertEqual(failure.exception.code, "update_in_progress")
        restarted.assert_not_called()
        self.assert_preserved()

    def test_fetch_or_projection_failure_preserves_good_config(self):
        for failed_fetch in (manage.ProxyError("fetch_failed"), lambda _url: b"proxies: []",
                             lambda _url: subscription([node(**{"skip-cert-verify": "true"})]),
                             lambda _url: subscription([node(**{"dialer-proxy": "DIRECT"})])):
            stack, restarted = self.patches(fetch=failed_fetch)
            with self.subTest(failure=type(failed_fetch).__name__), stack, self.assertRaises(manage.ProxyError):
                manage.update(self.paths)
            restarted.assert_not_called()
            self.assert_preserved()

    def test_candidate_validation_failure_preserves_config_and_private_previous(self):
        stack, restarted = self.patches(validate=manage.ProxyError("config_validation_failed"))
        with stack, self.assertRaises(manage.ProxyError) as failure:
            manage.update(self.paths)
        self.assertEqual(failure.exception.code, "config_validation_failed")
        restarted.assert_not_called()
        self.assert_preserved()
        saved = json.loads((self.paths.state_dir / "status.json").read_bytes())
        self.assertEqual(saved["code"], "config_validation_failed")
        self.assertEqual(saved["node_count"], 1)
        self.assertNotIn(SYNTHETIC_SECRET, json.dumps(saved))

    def test_success_has_private_backup_and_does_not_start_inactive_service(self):
        stack, restarted = self.patches()
        with stack:
            result = manage.update(self.paths)
        restarted.assert_not_called()
        self.assertEqual(result["status"], "updated")
        self.assertIs(result["service_active"], False)
        self.assertEqual((self.paths.config_dir / "config.previous.json").read_bytes(), self.original)
        for path in (self.paths.config_dir / "config.json", self.paths.config_dir / "config.previous.json",
                     self.paths.state_dir / "status.json", self.paths.state_dir / "update.lock"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertNotIn(SYNTHETIC_SECRET, json.dumps(result))

    def test_failed_updated_service_is_restarted_after_restoring_known_good(self):
        runtime = {"active": True}

        def systemctl(args, **_kwargs):
            self.assertEqual(args[:2], ["systemctl", "--user"])
            action = args[2]
            if action == "is-active":
                state = b"active" if runtime["active"] else b"failed"
                return subprocess.CompletedProcess(args, 0 if runtime["active"] else 3, state, b"")
            if action == "try-restart":
                if not runtime["active"]:
                    return subprocess.CompletedProcess(args, 0, b"", b"")
                runtime["active"] = False
                return subprocess.CompletedProcess(args, 1, b"", b"")
            if action == "restart":
                self.assert_preserved()
                runtime["active"] = True
                return subprocess.CompletedProcess(args, 0, b"", b"")
            self.fail("unexpected service operation")

        def reachable():
            if not runtime["active"]:
                raise manage.ProxyError("upstream_verification_failed")

        with mock.patch.object(manage, "fetch_subscription",
                               return_value=subscription([node(password="synthetic-new")])), \
                mock.patch.object(manage, "validate_candidate"), \
                mock.patch.object(manage.subprocess, "run", side_effect=systemctl), \
                mock.patch.object(manage, "verify_proxy", side_effect=reachable), \
                self.assertRaises(manage.ProxyError) as failure:
            manage.update(self.paths)
        self.assertEqual(failure.exception.code, "service_restart_failed")
        self.assertTrue(runtime["active"])
        self.assert_preserved()

    def test_operator_stop_during_update_is_not_undone_by_recovery(self):
        runtime = {"active": True}

        def systemctl(args, **_kwargs):
            action = args[2]
            if action == "is-active":
                state = b"active" if runtime["active"] else b"inactive"
                return subprocess.CompletedProcess(args, 0 if runtime["active"] else 3, state, b"")
            if action == "try-restart":
                runtime["active"] = False
                return subprocess.CompletedProcess(args, 0, b"", b"")
            self.fail("recovery must not restart an intentionally stopped service")

        with mock.patch.object(manage, "fetch_subscription",
                               return_value=subscription([node(password="synthetic-new")])), \
                mock.patch.object(manage, "validate_candidate"), \
                mock.patch.object(manage.subprocess, "run", side_effect=systemctl), \
                mock.patch.object(manage, "verify_proxy",
                                  side_effect=manage.ProxyError("upstream_verification_failed")), \
                self.assertRaises(manage.ProxyError) as failure:
            manage.update(self.paths)
        self.assertEqual(failure.exception.code, "upstream_verification_failed")
        self.assertFalse(runtime["active"])
        self.assert_preserved()

    def test_valid_but_unreachable_update_restores_known_good_service(self):
        stack, restarted = self.patches(active=True)
        with stack, mock.patch.object(
            manage, "verify_proxy",
            side_effect=[manage.ProxyError("upstream_verification_failed"), None],
        ), self.assertRaises(manage.ProxyError) as failure:
            manage.update(self.paths)
        self.assertEqual(failure.exception.code, "upstream_verification_failed")
        self.assert_preserved()

    def test_failed_rollback_restart_is_failure_not_success(self):
        stack, restarted = self.patches(active=True, restart=manage.ProxyError("service_restart_failed"))
        with stack, self.assertRaises(manage.ProxyError) as failure:
            manage.update(self.paths)
        self.assertEqual(failure.exception.code, "rollback_failed")
        self.assert_preserved()

    def test_failure_after_config_rename_restores_both_old_files(self):
        install = manage.PrivateDirectory.install
        failed_once = False

        def install_then_fail(directory, staged, name):
            nonlocal failed_once
            install(directory, staged, name)
            if name == "config.json" and not failed_once:
                failed_once = True
                raise OSError("synthetic post-rename fsync failure")

        stack, restarted = self.patches()
        with stack, mock.patch.object(manage.PrivateDirectory, "install", install_then_fail), \
                self.assertRaises(manage.ProxyError):
            manage.update(self.paths)
        restarted.assert_not_called()
        self.assert_preserved()

    def test_status_write_failure_rolls_back_running_service_and_config(self):
        write = manage.PrivateDirectory.write
        failed_once = False

        def fail_first_status(directory, name, data):
            nonlocal failed_once
            if name == "status.json" and not failed_once:
                failed_once = True
                raise OSError("synthetic state write failure")
            return write(directory, name, data)

        stack, restarted = self.patches(active=True)
        with stack, mock.patch.object(manage.PrivateDirectory, "write", fail_first_status), \
                self.assertRaises(manage.ProxyError) as failure:
            manage.update(self.paths)
        self.assertEqual(failure.exception.code, "filesystem_failed")
        self.assert_preserved()

    def test_first_install_validation_failure_does_not_publish_candidate(self):
        (self.paths.config_dir / "config.json").unlink()
        (self.paths.config_dir / "config.previous.json").unlink()
        stack, _ = self.patches(validate=manage.ProxyError("config_validation_failed"))
        with stack, self.assertRaises(manage.ProxyError):
            manage.update(self.paths)
        self.assertFalse((self.paths.config_dir / "config.json").exists())
        self.assertEqual(list(self.paths.config_dir.glob(".candidate-*")), [])
        self.assertEqual(manage.status(self.paths)["code"], "config_validation_failed")

    def test_status_never_claims_ready_while_service_is_inactive(self):
        with mock.patch.object(manage, "service_active", return_value=False):
            result = manage.status(self.paths)
        self.assertEqual(result["status"], "configured")
        self.assertEqual(result["node_count"], 1)
        self.assertNotIn(SYNTHETIC_SECRET, json.dumps(result))

    def test_untrusted_status_strings_are_not_echoed(self):
        saved = manage.report("failed", "fetch_failed")
        saved["checks"] = [SYNTHETIC_SECRET]
        with manage.PrivateDirectory(self.paths.state_dir) as state:
            state.write("status.json", manage.encode(saved))
        output = io.StringIO()
        with mock.patch.object(manage.Path, "home", return_value=self.paths.home), \
                mock.patch.object(manage, "service_active", return_value=False), redirect_stdout(output):
            code = manage.main(["status"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue())["code"], "state_invalid")
        self.assertNotIn(SYNTHETIC_SECRET, output.getvalue())

    def test_validation_output_is_captured_and_never_disclosed(self):
        self.paths.binary.parent.mkdir(parents=True, mode=0o700)
        self.paths.binary.write_bytes(b"synthetic executable fixture, never executed")
        self.paths.binary.chmod(0o700)
        output = io.StringIO()
        errors = io.StringIO()
        failed = subprocess.CompletedProcess([], 1, SYNTHETIC_SECRET.encode(), SYNTHETIC_SECRET.encode())
        with mock.patch.object(manage.Path, "home", return_value=self.paths.home), \
                mock.patch.object(manage, "fetch_subscription", return_value=subscription()), \
                mock.patch.object(manage.subprocess, "run", return_value=failed) as invoked, \
                redirect_stdout(output), redirect_stderr(errors):
            result = manage.main(["update"])
        self.assertEqual(result, 1)
        self.assertTrue(invoked.call_args.kwargs["capture_output"])
        self.assertEqual(json.loads(output.getvalue())["code"], "config_validation_failed")
        self.assertNotIn(SYNTHETIC_SECRET, output.getvalue() + errors.getvalue())
        self.assert_preserved()


class DnsPolicyProjectionTests(unittest.TestCase):
    PROVIDER = "tls://192.0.2.10:10853"

    def project(self, policy, nodes=None):
        return manage.project_subscription(subscription(nodes, dns={"enable": True, "listen": "0.0.0.0:53",
                                                                     "nameserver-policy": policy}))

    def test_covering_encrypted_rules_resolve_only_node_names(self):
        value = self.project({"+.example.com": [self.PROVIDER, "https://dns.example.net/dns-query"],
                              "+.unrelated.example.org": "tls://192.0.2.11",
                              "geosite:cn": "tls://192.0.2.12"})
        dns = value["dns"]
        self.assertEqual(dns["proxy-server-nameserver-policy"],
                         {"+.example.com": [self.PROVIDER, "https://dns.example.net/dns-query"]})
        self.assertIs(dns["enable"], True)
        self.assertNotIn("listen", dns)
        self.assertNotIn("nameserver-policy", dns)
        self.assertEqual(dns["nameserver"], ["system://"])
        self.assertEqual(dns["proxy-server-nameserver"], ["system://"])
        self.assertEqual(dns["default-nameserver"], ["system://"])
        self.assertEqual(dns["enhanced-mode"], "normal")
        self.assertIs(dns["respect-rules"], False)
        self.assertIs(dns["ipv6"], False)
        self.assertEqual(value["rules"][-1], "MATCH,REJECT")

    def test_pattern_forms_and_comma_keys(self):
        nodes = [node(server="a.node.example.com"), node(server="b.example.net"), node(server="192.0.2.50")]
        value = self.project({"*.node.example.com": self.PROVIDER, "b.example.net,+.other.example": self.PROVIDER,
                              "*.example.com": self.PROVIDER, "c.example.net": self.PROVIDER}, nodes)
        self.assertEqual(set(value["dns"]["proxy-server-nameserver-policy"]),
                         {"*.node.example.com", "b.example.net"})
        self.assertTrue(manage._pattern_covers("+.example.com", "example.com"))
        self.assertTrue(manage._pattern_covers("+.example.com", "x.y.example.com"))
        self.assertFalse(manage._pattern_covers("*.example.com", "x.y.example.com"))
        self.assertFalse(manage._pattern_covers("+.example.com", "badexample.com"))

    def test_no_policy_or_no_covering_rule_keeps_dns_disabled(self):
        for root in ({}, {"dns": {"enable": True}},
                     {"dns": {"nameserver-policy": {"+.example.org": self.PROVIDER}}}):
            with self.subTest(root=root):
                value = manage.project_subscription(subscription(**root))
                self.assertEqual(value["dns"], {"enable": False})

    def test_plain_or_unsafe_upstreams_are_dropped_and_all_dropped_fails_closed(self):
        value = self.project({"+.example.com": ["192.0.2.10", "udp://192.0.2.10", self.PROVIDER]})
        self.assertEqual(value["dns"]["proxy-server-nameserver-policy"], {"+.example.com": [self.PROVIDER]})
        for unsafe in ("192.0.2.10", "udp://192.0.2.10:53", "tcp://192.0.2.10", "quic://192.0.2.10",
                       "system://", "dhcp://system", "http://dns.example.net/dns-query",
                       "tls://192.0.2.10#AUTO", "https://dns.example.net/dns-query?x=1",
                       "tls://user:pw@192.0.2.10", "tls://127.0.0.1:853", "tls://10.0.0.1",
                       "tls://resolver.local", "tls://localhost", "tls://192.0.2.10/path",
                       "tls://192.0.2.10:0", "https://dns.example.net/a b", 53, None):
            with self.subTest(unsafe=unsafe), self.assertRaises(manage.ProxyError) as failure:
                self.project({"+.example.com": [unsafe]})
            self.assertEqual(failure.exception.code, "dns_policy_unsupported")
        for safe in ("tls://192.0.2.10", "tls://dns.example.net:853", "https://dns.example.net",
                     "https://198.51.100.7:8443/dns-query"):
            with self.subTest(safe=safe):
                self.assertEqual(self.project({"+.example.com": safe})["dns"]
                                 ["proxy-server-nameserver-policy"]["+.example.com"], [safe])

    def test_shape_and_count_limits(self):
        for policy in ([self.PROVIDER], "tls://192.0.2.10"):
            with self.subTest(policy=policy), self.assertRaises(manage.ProxyError) as failure:
                self.project(policy)
            self.assertEqual(failure.exception.code, "dns_policy_invalid")
        with self.assertRaises(manage.ProxyError) as failure:
            manage.project_subscription(subscription(dns=["nameserver-policy"]))
        self.assertEqual(failure.exception.code, "dns_policy_invalid")
        for entries in ([self.PROVIDER] * (manage.MAX_DNS_SERVERS + 1), []):
            with self.subTest(entries=len(entries)), self.assertRaises(manage.ProxyError) as failure:
                self.project({"+.example.com": entries})
            self.assertEqual(failure.exception.code, "dns_policy_invalid")
        servers = [f"n{number}.example.com" for number in range(manage.MAX_DNS_POLICIES + 1)]
        nodes = [node(server=server) for server in servers]
        exact = {server: self.PROVIDER for server in servers}
        with self.assertRaises(manage.ProxyError) as failure:
            self.project(exact, nodes)
        self.assertEqual(failure.exception.code, "dns_policy_invalid")
        exact.pop(servers[-1])
        self.assertEqual(len(self.project(exact, nodes)["dns"]["proxy-server-nameserver-policy"]),
                         manage.MAX_DNS_POLICIES)

    def test_projected_policy_never_echoes_other_dns_settings(self):
        value = self.project({"+.example.com": self.PROVIDER, "+.private.example.org": "tls://192.0.2.99"})
        text = manage.encode(value).decode()
        self.assertNotIn("192.0.2.99", text)
        self.assertNotIn("0.0.0.0:53", text)


class UpdateImprovementTests(unittest.TestCase):
    setUp = ManagerSafetyTests.setUp
    patches = ManagerSafetyTests.patches
    assert_preserved = ManagerSafetyTests.assert_preserved

    def test_identical_projection_skips_commit_and_restart_but_verifies(self):
        stack, restarted = self.patches(fetch=lambda _url: subscription(), active=True)
        with stack, mock.patch.object(manage, "verify_proxy") as verified, \
                mock.patch.object(manage.PrivateDirectory, "install", autospec=True,
                                  side_effect=manage.PrivateDirectory.install) as installed:
            result = manage.update(self.paths)
        restarted.assert_not_called()
        self.assertEqual([call.args[2] for call in installed.call_args_list], ["status.json"])
        verified.assert_called_once()
        self.assertEqual(result["status"], "updated")
        self.assertNotIn("configuration_committed", result["checks"])
        self.assertIn("proxy_https_verified", result["checks"])
        self.assert_preserved()

    def test_identical_projection_with_unreachable_upstream_reports_upstream(self):
        stack, restarted = self.patches(fetch=lambda _url: subscription(), active=True)
        with stack, mock.patch.object(manage, "verify_proxy",
                                      side_effect=manage.ProxyError("upstream_verification_failed")), \
                self.assertRaises(manage.ProxyError) as failure:
            manage.update(self.paths)
        restarted.assert_not_called()
        self.assertEqual(failure.exception.code, "upstream_verification_failed")
        self.assert_preserved()

    def test_restored_but_still_unreachable_is_upstream_not_rollback_failure(self):
        stack, restarted = self.patches(active=True)
        with stack, mock.patch.object(manage, "verify_proxy",
                                      side_effect=manage.ProxyError("upstream_verification_failed")), \
                self.assertRaises(manage.ProxyError) as failure:
            manage.update(self.paths)
        self.assertEqual(failure.exception.code, "upstream_verification_failed")
        self.assert_preserved()

    def test_failed_update_prints_checks_and_node_count(self):
        output = io.StringIO()
        stack, _ = self.patches(validate=manage.ProxyError("config_validation_failed"))
        with stack, mock.patch.object(manage.Path, "home", return_value=self.paths.home), \
                redirect_stdout(output):
            self.assertEqual(manage.main(["update"]), 1)
        printed = json.loads(output.getvalue())
        self.assertEqual(printed["code"], "config_validation_failed")
        self.assertEqual(printed["node_count"], 1)
        self.assertIn("subscription_projected", printed["checks"])
        self.assertNotIn(SYNTHETIC_SECRET, output.getvalue())


class DiagnoseTests(unittest.TestCase):
    setUp = ManagerSafetyTests.setUp

    def install(self, policy):
        root = {"dns": {"nameserver-policy": policy}} if policy else {}
        config = manage.project_subscription(subscription(
            [node(server="a.example.com", port=1001), node(server="a.example.com", port=1002),
             node(server="b.example.net"), node(server="192.0.2.60", type="hysteria2")], **root))
        with manage.PrivateDirectory(self.paths.config_dir) as directory:
            directory.write("config.json", manage.encode(config))

    def run_diagnose(self, connect):
        output = io.StringIO()
        with mock.patch.object(manage.Path, "home", return_value=self.paths.home), \
                mock.patch.object(manage, "resolve_system", return_value=["198.51.100.1"]), \
                mock.patch.object(manage, "resolve_encrypted", return_value=["203.0.113.5"]), \
                mock.patch.object(manage, "tcp_connect", side_effect=connect), \
                mock.patch.object(manage, "verify_proxy"), redirect_stdout(output):
            self.assertEqual(manage.main(["diagnose"]), 0)
        return output.getvalue(), json.loads(output.getvalue())

    def test_counts_by_resolution_without_addresses(self):
        self.install({"+.example.com": "tls://192.0.2.10:10853"})
        text, result = self.run_diagnose(
            lambda address, _port: "connect_ok" if address == "203.0.113.5" else "connect_timeout")
        self.assertEqual(result["node_count"], 4)
        self.assertEqual(result["tcp_endpoints"], 3)
        self.assertEqual(result["provider_policies"], 1)
        self.assertEqual(result["names_with_different_answers"], 1)
        self.assertEqual(result["resolution"]["system"],
                         {"covered": 3, "resolved": 3, "unresolved": 0, "connect_ok": 0,
                          "connect_timeout": 3, "connect_failed": 0})
        self.assertEqual(result["resolution"]["provider_dns"],
                         {"covered": 2, "resolved": 2, "unresolved": 0, "connect_ok": 2,
                          "connect_timeout": 0, "connect_failed": 0})
        self.assertIs(result["proxy_https_verified"], True)
        for secret in ("example.com", "example.net", "192.0.2", "198.51.100", "203.0.113", "1001",
                       SYNTHETIC_SECRET):
            self.assertNotIn(secret, text)

    def test_without_policy_only_system_counts(self):
        self.install(None)
        _, result = self.run_diagnose(lambda *_: "connect_failed")
        self.assertEqual(result["resolution"]["provider_dns"]["covered"], 0)
        self.assertEqual(result["resolution"]["system"]["connect_failed"], 3)

    def test_unconfigured_is_content_free_failure(self):
        (self.paths.config_dir / "config.json").unlink()
        output = io.StringIO()
        with mock.patch.object(manage.Path, "home", return_value=self.paths.home), redirect_stdout(output):
            self.assertEqual(manage.main(["diagnose"]), 1)
        self.assertEqual(json.loads(output.getvalue())["code"], "not_configured")

    def test_dns_answer_parser(self):
        question = manage._dns_question("a.example.com", 0x1234)
        answer = (struct.pack("!HHHHHH", 0x1234, 0x8180, 1, 2, 0, 0) + question[12:]
                  + b"\xc0\x0c" + struct.pack("!HHIH", 5, 1, 60, 2) + b"\xc0\x0c"
                  + b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + bytes([192, 0, 2, 7]))
        self.assertEqual(manage._a_records(answer, 0x1234), ["192.0.2.7"])
        self.assertEqual(manage._a_records(answer, 0x9999), [])
        self.assertEqual(manage._a_records(answer[:20], 0x1234), [])


class ChildBoundaryTests(unittest.TestCase):
    def test_proxy_environment_is_child_only_and_never_echoes_command(self):
        inherited = {"HTTP_PROXY": "http://synthetic-old:1", "all_proxy": "socks5://synthetic-old:2",
                     "NO_PROXY": "*", "FTP_PROXY": "http://synthetic-old:3", "KEEP_SYNTHETIC": "unchanged"}
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, inherited, clear=True), \
                mock.patch.object(manage.subprocess, "run", return_value=subprocess.CompletedProcess([], 7)) as invoked, \
                redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(manage.main(["run", "--", "synthetic-command", SYNTHETIC_SECRET]), 7)
            self.assertEqual(dict(os.environ), inherited)
        child = invoked.call_args.kwargs["env"]
        self.assertNotIn("FTP_PROXY", child)
        self.assertEqual(child["KEEP_SYNTHETIC"], "unchanged")
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            self.assertEqual(child[key], "http://127.0.0.1:7890")
        for bypass in ("localhost", "127.0.0.1", "::1", ".ts.net", "100.64.0.0/10", "10.0.0.0/8",
                       "172.16.0.0/12", "192.168.0.0/16"):
            self.assertIn(bypass, child["NO_PROXY"].split(","))
        self.assertEqual(child["NO_PROXY"], child["no_proxy"])
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")

    def test_command_failure_and_bad_arguments_are_content_free(self):
        output = io.StringIO()
        with mock.patch.object(manage.subprocess, "run", side_effect=OSError(SYNTHETIC_SECRET)), \
                redirect_stdout(output):
            self.assertEqual(manage.main(["run", "--", SYNTHETIC_SECRET]), 1)
        self.assertEqual(json.loads(output.getvalue())["code"], "command_failed")
        self.assertNotIn(SYNTHETIC_SECRET, output.getvalue())
        output = io.StringIO()
        errors = io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors), self.assertRaises(SystemExit) as failure:
            manage.main(["update", "--unrecognized", SYNTHETIC_SECRET])
        self.assertEqual(failure.exception.code, 2)
        self.assertNotIn(SYNTHETIC_SECRET, output.getvalue() + errors.getvalue())


if __name__ == "__main__":
    unittest.main()
