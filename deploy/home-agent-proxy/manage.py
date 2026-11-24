#!/usr/bin/env python3
"""Manage one private, loopback-only Mihomo instance without exposing its inputs."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import ssl
import stat
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import yaml


VERSION = "v1.19.33"
# Release directory: Mihomo version plus helper revision, so a new helper never overwrites the old one.
RELEASE = "v1.19.33-2"
SERVICE = "home-agent-proxy.service"
MAX_BODY = 4 * 1024 * 1024
MAX_NODES = 256
FETCH_SECONDS = 30
NODE_FIELDS = frozenset({
    "name", "type", "server", "port", "password", "sni", "alpn",
    "client-fingerprint", "udp", "skip-cert-verify",
})
NODE_TYPES = ("anytls", "hysteria2")
# The provider's node names only resolve through its own encrypted DNS (subscription dns.nameserver-policy).
MAX_DNS_POLICIES = 16
MAX_DNS_SERVERS = 8
DNS_SECONDS = 5
CONNECT_SECONDS = 5
# Explicitly authorized for public software/dependency downloads, not model/channel traffic.
DOWNLOAD_DOMAINS = (
    "docker.io", "docker.com", "cloudflarestorage.com",
    "github.com", "githubusercontent.com", "npmjs.org",
    "pypi.org", "pythonhosted.org", "nodejs.org",
)
BYPASS = "localhost,127.0.0.1,::1,.ts.net,100.64.0.0/10,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
CHECKS = frozenset({
    "private_files_checked", "subscription_https_verified", "subscription_projected",
    "configuration_validated", "configuration_committed", "service_restarted", "proxy_https_verified",
})
CODES = frozenset({
    "ok", "not_configured", "update_in_progress", "unsafe_file", "unsafe_directory",
    "invalid_url", "fetch_failed", "fetch_timeout", "subscription_too_large",
    "subscription_invalid", "unsupported_node", "unsupported_node_field",
    "dns_policy_invalid", "dns_policy_unsupported",
    "config_validation_failed", "service_query_failed",
    "service_restart_failed", "upstream_verification_failed", "rollback_failed",
    "filesystem_failed", "state_invalid",
    "command_required", "command_failed", "interrupted", "invalid_arguments", "internal_error",
})
STATUSES = frozenset({"ready", "configured", "updated", "failed", "not_configured"})
PRIVATE_NETWORKS = (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "198.18.0.0/15",
    "224.0.0.0/4", "240.0.0.0/4",
)
PRIVATE_NETWORKS6 = ("::/128", "::1/128", "::ffff:0:0/96", "fc00::/7", "fe80::/10", "ff00::/8")


class ProxyError(RuntimeError):
    def __init__(self, code: str, result: dict | None = None):
        self.code = code if code in CODES else "internal_error"
        # Content-free failure report already written to status.json; printed instead of an empty one.
        self.result = result
        super().__init__(self.code)


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        print(encode(report("failed", "invalid_arguments")).decode("utf-8"), end="")
        raise SystemExit(2)


@dataclass(frozen=True)
class Paths:
    home: Path

    @property
    def config_dir(self) -> Path:
        return self.home / ".config/home-agent-proxy"

    @property
    def state_dir(self) -> Path:
        return self.home / ".local/state/home-agent-proxy"

    @property
    def binary(self) -> Path:
        return self.home / ".local/lib/home-agent-proxy/releases" / RELEASE / "mihomo"


class PrivateDirectory:
    """Use directory FDs so private reads/replacements never follow symlinks."""

    def __init__(self, path: Path, *, create: bool = False):
        self.path = path.absolute()
        self.fd = os.open("/", getattr(os, "O_PATH", os.O_RDONLY) | os.O_DIRECTORY)
        try:
            for component in self.path.parts[1:]:
                if create:
                    try:
                        os.mkdir(component, 0o700, dir_fd=self.fd)
                    except FileExistsError:
                        pass
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                  dir_fd=self.fd)
                os.close(self.fd)
                self.fd = next_fd
            info = os.fstat(self.fd)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise ProxyError("unsafe_directory")
        except OSError:
            os.close(self.fd)
            raise ProxyError("unsafe_directory") from None
        except BaseException:
            os.close(self.fd)
            raise

    def __enter__(self):
        return self

    def __exit__(self, *_):
        os.close(self.fd)

    @staticmethod
    def _check(info):
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
            raise ProxyError("unsafe_file")

    def read(self, name: str, *, optional: bool = False, maximum: int = MAX_BODY * 2) -> bytes | None:
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        except FileNotFoundError:
            if optional:
                return None
            raise ProxyError("unsafe_file") from None
        except OSError:
            raise ProxyError("unsafe_file") from None
        try:
            self._check(os.fstat(fd))
            with os.fdopen(fd, "rb", closefd=False) as source:
                data = source.read(maximum + 1)
            if len(data) > maximum:
                raise ProxyError("unsafe_file")
            return data
        finally:
            os.close(fd)

    def stage(self, data: bytes) -> str:
        name = ".candidate-" + secrets.token_hex(16)
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600,
                     dir_fd=self.fd)
        try:
            with os.fdopen(fd, "wb", closefd=False) as output:
                output.write(data)
                output.flush()
                os.fsync(fd)
        except BaseException:
            os.unlink(name, dir_fd=self.fd)
            raise
        finally:
            os.close(fd)
        return name

    def install(self, staged: str, name: str):
        self.read(name, optional=True)
        os.replace(staged, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
        os.fsync(self.fd)

    def write(self, name: str, data: bytes):
        staged = self.stage(data)
        try:
            self.install(staged, name)
        finally:
            self.remove(staged)

    def remove(self, name: str):
        try:
            self.read(name)
        except ProxyError:
            try:
                os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            except FileNotFoundError:
                return
            raise
        os.unlink(name, dir_fd=self.fd)
        os.fsync(self.fd)

    @contextmanager
    def update_lock(self):
        fd = os.open("update.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                     0o600, dir_fd=self.fd)
        try:
            self._check(os.fstat(fd))
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ProxyError("update_in_progress") from None
            yield
        finally:
            os.close(fd)


@contextmanager
def fetch_deadline():
    def expired(*_):
        raise ProxyError("fetch_timeout")

    old_handler = signal.signal(signal.SIGALRM, expired)
    old_timer = signal.setitimer(signal.ITIMER_REAL, FETCH_SECONDS)
    started = time.monotonic()
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)
        if old_timer[0]:
            signal.setitimer(signal.ITIMER_REAL, max(0.001, old_timer[0] - (time.monotonic() - started)),
                             old_timer[1])


def validate_url(raw: bytes) -> str:
    try:
        url = raw.decode("ascii").strip("\r\n")
        if not url or any(ord(char) <= 32 or ord(char) == 127 for char in url) or "\\" in url:
            raise ValueError
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname
        if (parsed.scheme != "https" or not host or parsed.username is not None
                or parsed.password is not None or parsed.fragment or parsed.port == 0):
            raise ValueError
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if (len(host) > 253 or "." not in host or host.rstrip(".").split(".")[-1].isdecimal()
                    or host.rstrip(".").endswith((".local", ".localhost", ".localdomain", ".ts.net"))
                    or not all(re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label)
                               for label in host.rstrip(".").split("."))):
                raise ValueError
        else:
            if not address.is_global:
                raise ValueError
        return url
    except (UnicodeError, ValueError):
        raise ProxyError("invalid_url") from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ProxyError("fetch_failed")


def fetch_subscription(url: str) -> bytes:
    url = validate_url(url.encode("utf-8"))
    context = ssl.create_default_context()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                         urllib.request.HTTPSHandler(context=context), NoRedirect())
    request = urllib.request.Request(url, headers={
        "Accept": "application/yaml, text/yaml, text/plain", "User-Agent": "clash.meta",
    })
    try:
        with fetch_deadline(), opener.open(request, timeout=10) as response:
            if response.status != 200 or response.headers.get("Content-Encoding", "identity") != "identity":
                raise ProxyError("fetch_failed")
            length = response.headers.get("Content-Length")
            if length is not None and (not length.isdecimal() or int(length) > MAX_BODY):
                raise ProxyError("subscription_too_large")
            body = response.read(MAX_BODY + 1)
            if len(body) > MAX_BODY:
                raise ProxyError("subscription_too_large")
            return body
    except ProxyError:
        raise
    except (TimeoutError, urllib.error.URLError, OSError, ValueError):
        raise ProxyError("fetch_failed") from None


def _text(value, *, maximum: int = 8192) -> bool:
    return (isinstance(value, str) and 0 < len(value) <= maximum
            and all(ord(char) >= 32 and ord(char) != 127 for char in value))


def _host(value) -> bool:
    if not _text(value, maximum=253) or any(char.isspace() for char in value):
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return all(re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label)
                   for label in value.rstrip(".").split("."))


def _domain(value) -> str | None:
    """A lower-case DNS name with at least two labels; IP literals are not names."""
    if not _host(value):
        return None
    try:
        ipaddress.ip_address(value)
        return None
    except ValueError:
        name = value.rstrip(".").lower()
        return name if "." in name else None


def _dns_pattern(value) -> str | None:
    """Mihomo domain keys: "+.x" (x and below), "*.x" (one level below) or exact "x"."""
    if not isinstance(value, str):
        return None
    prefix = value[:2] if value[:2] in ("+.", "*.") else ""
    name = _domain(value[len(prefix):])
    return prefix + name if name else None


def _pattern_covers(pattern: str, domain: str) -> bool:
    if pattern.startswith("+."):
        return domain == pattern[2:] or domain.endswith(pattern[1:])
    if pattern.startswith("*."):
        return domain.endswith(pattern[1:]) and "." not in domain[:-len(pattern) + 1]
    return domain == pattern


def _dns_server(value) -> str | None:
    """Only encrypted upstreams (tls:// or https://), no credentials, query, fragment or internal host."""
    if not _text(value, maximum=512) or any(char.isspace() or char in "\\?#" for char in value):
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        return None
    if (parsed.scheme not in ("tls", "https") or not host or parsed.username is not None
            or parsed.password is not None or port == 0):
        return None
    if parsed.path and (parsed.scheme == "tls"
                        or not re.fullmatch(r"(?:/[A-Za-z0-9._~-]+)+/?", parsed.path)):
        return None
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        name = _domain(host)
        if name is None or name.endswith((".local", ".localhost", ".localdomain", ".ts.net")):
            return None
    else:
        if any(address in ipaddress.ip_network(network)
               for network in PRIVATE_NETWORKS + PRIVATE_NETWORKS6 if
               ipaddress.ip_network(network).version == address.version):
            return None
    return value


def project_dns_policy(root: dict, servers) -> dict:
    """Keep the subscription's DNS rules that cover node names, limited to encrypted upstreams."""
    dns = root.get("dns")
    if dns is None:
        return {}
    if not isinstance(dns, dict):
        raise ProxyError("dns_policy_invalid")
    source = dns.get("nameserver-policy")
    if source is None:
        return {}
    if not isinstance(source, dict):
        raise ProxyError("dns_policy_invalid")
    domains = {name for name in map(_domain, servers) if name}
    policy = {}
    for key, value in source.items():
        if not isinstance(key, str):
            continue
        patterns = [pattern for pattern in map(_dns_pattern, key.split(","))
                    if pattern and any(_pattern_covers(pattern, name) for name in domains)]
        if not patterns:
            continue
        entries = value if isinstance(value, list) else [value]
        if not 1 <= len(entries) <= MAX_DNS_SERVERS:
            raise ProxyError("dns_policy_invalid")
        allowed = list(dict.fromkeys(entry for entry in map(_dns_server, entries) if entry))
        if not allowed:
            raise ProxyError("dns_policy_unsupported")
        for pattern in patterns:
            policy.setdefault(pattern, allowed)
        if len(policy) > MAX_DNS_POLICIES:
            raise ProxyError("dns_policy_invalid")
    return policy


def project_subscription(body: bytes) -> dict:
    try:
        root = yaml.safe_load(body)
    except (yaml.YAMLError, UnicodeError, ValueError, RecursionError):
        raise ProxyError("subscription_invalid") from None
    if not isinstance(root, dict) or not isinstance(root.get("proxies"), list):
        raise ProxyError("subscription_invalid")
    source = root["proxies"]
    if not 1 <= len(source) <= MAX_NODES:
        raise ProxyError("subscription_invalid")
    nodes = []
    for number, node in enumerate(source, 1):
        if not isinstance(node, dict) or not set(node).issubset(NODE_FIELDS):
            raise ProxyError("unsupported_node_field")
        if node.get("type") not in NODE_TYPES:
            raise ProxyError("unsupported_node")
        if (not _text(node.get("name"), maximum=512) or not _host(node.get("server"))
                or type(node.get("port")) is not int or not 1 <= node["port"] <= 65535
                or not _text(node.get("password"))):
            raise ProxyError("unsupported_node")
        if "skip-cert-verify" in node and type(node["skip-cert-verify"]) is not bool:
            raise ProxyError("unsupported_node")
        if "sni" in node and not _host(node["sni"]):
            raise ProxyError("unsupported_node")
        if "udp" in node and type(node["udp"]) is not bool:
            raise ProxyError("unsupported_node")
        if "client-fingerprint" in node and not _text(node["client-fingerprint"], maximum=64):
            raise ProxyError("unsupported_node")
        if "alpn" in node and (not isinstance(node["alpn"], list) or not 1 <= len(node["alpn"]) <= 16
                               or not all(_text(item, maximum=64) for item in node["alpn"])):
            raise ProxyError("unsupported_node")
        projected = {key: node[key] for key in NODE_FIELDS if key in node}
        projected["name"] = f"node-{number:03d}"
        # Operator accepted the subscription's self-signed-node policy; target HTTPS is unchanged.
        projected["skip-cert-verify"] = node.get("skip-cert-verify", False)
        nodes.append(projected)
    policy = project_dns_policy(root, [node["server"] for node in nodes])
    # Without provider rules Mihomo keeps using the system resolver, exactly as before.
    dns = {"enable": False}
    if policy:
        # The provider's resolvers only answer for node names (proxy-server-nameserver-policy);
        # every other lookup stays on the system resolver and no DNS listener is opened.
        dns = {"enable": True, "ipv6": False, "enhanced-mode": "normal", "respect-rules": False,
               "use-hosts": True, "use-system-hosts": True, "default-nameserver": ["system://"],
               "nameserver": ["system://"], "proxy-server-nameserver": ["system://"],
               "proxy-server-nameserver-policy": policy}
    rules = ["DOMAIN,localhost,REJECT", "DOMAIN-SUFFIX,localhost,REJECT", "DOMAIN-SUFFIX,local,REJECT",
             "DOMAIN-SUFFIX,ts.net,REJECT"]
    # Resolve destination names before CIDR matching; no-resolve would allow a private-IP hostname bypass.
    rules += [f"IP-CIDR,{network},REJECT" for network in PRIVATE_NETWORKS]
    rules += [f"IP-CIDR6,{network},REJECT" for network in PRIVATE_NETWORKS6]
    rules += [f"DOMAIN-SUFFIX,{domain},AUTO" for domain in DOWNLOAD_DOMAINS]
    return {
        "mixed-port": 7890, "allow-lan": False, "bind-address": "127.0.0.1",
        "mode": "rule", "log-level": "silent", "ipv6": False, "find-process-mode": "off",
        "tun": {"enable": False}, "dns": dns,
        "profile": {"store-selected": False, "store-fake-ip": False},
        "proxies": nodes,
        "proxy-groups": [{"name": "AUTO", "type": "url-test", "proxies": [node["name"] for node in nodes],
                          "url": "https://www.gstatic.com/generate_204", "interval": 300,
                          "tolerance": 50}],
        "rules": rules + ["MATCH,REJECT"],
    }


def counts(config: dict) -> dict:
    try:
        if (not isinstance(config, dict) or not isinstance(config.get("proxies"), list)
                or not 1 <= len(config["proxies"]) <= MAX_NODES):
            raise ValueError
        result = dict.fromkeys(NODE_TYPES, 0)
        for node in config["proxies"]:
            result[node["type"]] += 1
        return result
    except (ValueError, KeyError, TypeError):
        raise ProxyError("state_invalid") from None


def config_counts(raw: bytes | None) -> dict:
    if raw is None:
        return dict.fromkeys(NODE_TYPES, 0)
    try:
        return counts(json.loads(raw))
    except (ValueError, TypeError):
        raise ProxyError("state_invalid") from None


def report(status: str, code: str = "ok", *, node_types: dict | None = None,
           active: bool = False, checks=()) -> dict:
    node_types = dict(node_types or dict.fromkeys(NODE_TYPES, 0))
    return {"schema_version": 1, "status": status, "code": code,
            "node_count": sum(node_types.values()), "node_types": node_types,
            "service_active": active, "checks": list(checks)}


def encode(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def read_report(state: PrivateDirectory) -> dict | None:
    raw = state.read("status.json", optional=True, maximum=16384)
    if raw is None:
        return None
    try:
        value = json.loads(raw)
        if (not isinstance(value, dict) or set(value) != set(report("not_configured"))
                or type(value["schema_version"]) is not int or value["schema_version"] != 1
                or value["status"] not in STATUSES or value["code"] not in CODES
                or type(value["service_active"]) is not bool or type(value["node_count"]) is not int
                or not isinstance(value["node_types"], dict) or set(value["node_types"]) != set(NODE_TYPES)
                or any(type(count) is not int or not 0 <= count <= MAX_NODES
                       for count in value["node_types"].values())
                or value["node_count"] != sum(value["node_types"].values())
                or not 0 <= value["node_count"] <= MAX_NODES
                or not isinstance(value["checks"], list)
                or any(not isinstance(check, str) or check not in CHECKS for check in value["checks"])):
            raise ValueError
        return value
    except (ValueError, TypeError, KeyError):
        raise ProxyError("state_invalid") from None


def service_active() -> bool:
    try:
        result = subprocess.run(["systemctl", "--user", "is-active", "--quiet", SERVICE],
                                capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        raise ProxyError("service_query_failed") from None
    if result.returncode == 0:
        return True
    if result.returncode in (3, 4):
        return False
    raise ProxyError("service_query_failed")


def restart_service():
    try:
        result = subprocess.run(["systemctl", "--user", "try-restart", SERVICE],
                                capture_output=True, timeout=45)
    except (OSError, subprocess.SubprocessError):
        raise ProxyError("service_restart_failed") from None
    if result.returncode != 0:
        raise ProxyError("service_restart_failed")


def restore_service() -> bool:
    """Recover a failed update, but leave an explicitly inactive unit stopped."""
    try:
        state = subprocess.run(["systemctl", "--user", "is-active", SERVICE],
                               capture_output=True, timeout=15)
        if state.returncode == 3 and state.stdout.strip() == b"inactive":
            return False
        if state.stdout.strip() not in {b"active", b"activating", b"reloading", b"failed"}:
            raise ProxyError("service_restart_failed")
        result = subprocess.run(["systemctl", "--user", "restart", SERVICE],
                                capture_output=True, timeout=45)
    except (OSError, subprocess.SubprocessError):
        raise ProxyError("service_restart_failed") from None
    if result.returncode != 0:
        raise ProxyError("service_restart_failed")
    return True


def verify_proxy():
    """A restarted core must reach the registry over verified HTTPS, not just stay active."""
    try:
        result = subprocess.run(
            ["curl", "--silent", "--output", "/dev/null", "--proxy", "http://127.0.0.1:7890",
             "--noproxy", "", "--retry", "2", "--retry-connrefused", "--retry-delay", "1",
             "--retry-max-time", "15", "--connect-timeout", "5", "--max-time", "20",
             "--write-out", "%{http_code}", "https://registry-1.docker.io/v2/"],
            capture_output=True, timeout=40,
        )
    except (OSError, subprocess.SubprocessError):
        raise ProxyError("upstream_verification_failed") from None
    if result.returncode != 0 or result.stdout.strip() != b"401":
        raise ProxyError("upstream_verification_failed")


def validate_candidate(paths: Paths, candidate: Path):
    try:
        # Verify the executable path as well as private inputs without following a symlink.
        parent = paths.binary.parent
        fd = os.open("/", getattr(os, "O_PATH", os.O_RDONLY) | os.O_DIRECTORY)
        try:
            for component in parent.parts[1:]:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            binary_fd = os.open(paths.binary.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                info = os.fstat(binary_fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                    raise ProxyError("unsafe_file")
            finally:
                os.close(binary_fd)
        finally:
            os.close(fd)
        with PrivateDirectory(paths.state_dir / "core", create=True):
            pass
        result = subprocess.run([str(paths.binary), "-t", "-d", str(paths.state_dir / "core"),
                                 "-f", str(candidate)], capture_output=True, timeout=30)
    except ProxyError:
        raise
    except (OSError, subprocess.SubprocessError):
        raise ProxyError("config_validation_failed") from None
    if result.returncode != 0:
        raise ProxyError("config_validation_failed")


def update(paths: Paths) -> dict:
    with PrivateDirectory(paths.config_dir, create=True) as config, \
            PrivateDirectory(paths.state_dir, create=True) as state, state.update_lock():
        old = config.read("config.json", optional=True)
        old_previous = config.read("config.previous.json", optional=True)
        # Reject unsafe state before any config/service mutation.
        read_report(state)
        old_types = config_counts(old)
        checks = ["private_files_checked"]
        candidate = None
        committed = False
        backup_changed = False
        active = False
        restart_attempted = False
        try:
            url = validate_url(config.read("subscription-url", maximum=8192))
            body = fetch_subscription(url)
            checks.append("subscription_https_verified")
            controlled = project_subscription(body)
            checks.append("subscription_projected")
            candidate_bytes = encode(controlled)
            candidate = config.stage(candidate_bytes)
            validate_candidate(paths, config.path / candidate)
            checks.append("configuration_validated")
            active = service_active()
            if candidate_bytes == old:
                # Same bytes as the running config: no commit, no restart; only re-check reachability.
                config.remove(candidate)
                candidate = None
                if active:
                    verify_proxy()
                    checks.append("proxy_https_verified")
                result = report("updated", node_types=counts(controlled), active=service_active(),
                                checks=checks)
                state.write("status.json", encode(result))
                return result
            if old is not None:
                backup_changed = True
                config.write("config.previous.json", old)
            # Set before replace: even an fsync failure after rename must restore the old bytes.
            committed = True
            config.install(candidate, "config.json")
            candidate = None
            checks.append("configuration_committed")
            if active:
                restart_attempted = True
                restart_service()
                checks.append("service_restarted")
                verify_proxy()
                checks.append("proxy_https_verified")
            result = report("updated", node_types=counts(controlled), active=service_active(), checks=checks)
            state.write("status.json", encode(result))
            return result
        except BaseException as failure:
            rollback_ok = True
            try:
                if committed:
                    if old is None:
                        config.remove("config.json")
                    else:
                        config.write("config.json", old)
                if backup_changed:
                    if old_previous is None:
                        config.remove("config.previous.json")
                    else:
                        config.write("config.previous.json", old_previous)
            except (OSError, ProxyError):
                rollback_ok = False
            upstream_down = False
            if restart_attempted:
                try:
                    restored = restore_service()
                except ProxyError:
                    rollback_ok = False
                else:
                    try:
                        if restored:
                            verify_proxy()
                    except ProxyError:
                        # Files and service were restored; the upstream itself is unreachable.
                        upstream_down = True
            if isinstance(failure, (KeyboardInterrupt, SystemExit)):
                code = "interrupted"
            elif isinstance(failure, ProxyError):
                code = failure.code
            elif isinstance(failure, OSError):
                code = "filesystem_failed"
            else:
                code = "internal_error"
            if not rollback_ok:
                code = "rollback_failed"
            elif upstream_down:
                code = "upstream_verification_failed"
            result = report("failed", code, node_types=old_types, active=active, checks=checks)
            try:
                state.write("status.json", encode(result))
            except (OSError, ProxyError):
                pass
            raise ProxyError(code, result) from None
        finally:
            if candidate is not None:
                config.remove(candidate)


def status(paths: Paths) -> dict:
    current = None
    saved = None
    if paths.config_dir.exists() or paths.config_dir.is_symlink():
        with PrivateDirectory(paths.config_dir) as config:
            current = config.read("config.json", optional=True)
    if paths.state_dir.exists() or paths.state_dir.is_symlink():
        with PrivateDirectory(paths.state_dir) as state:
            saved = read_report(state)
    node_types = config_counts(current)
    active = service_active() if current is not None else False
    if saved is not None and saved["status"] == "failed":
        return report("failed", saved["code"], node_types=node_types, active=active, checks=saved["checks"])
    if current is None:
        return report("not_configured", "not_configured")
    return report("ready" if active else "configured", node_types=node_types, active=active,
                  checks=saved["checks"] if saved else ())


def _dns_question(name: str, ident: int) -> bytes:
    labels = b"".join(bytes([len(label)]) + label.encode("ascii") for label in name.rstrip(".").split("."))
    return struct.pack("!HHHHHH", ident, 0x0100, 1, 0, 0, 0) + labels + b"\0" + struct.pack("!HH", 1, 1)


def _skip_name(data: bytes, offset: int) -> int:
    while True:
        length = data[offset]
        if length & 0xC0 == 0xC0:
            return offset + 2
        if length == 0:
            return offset + 1
        offset += length + 1


def _a_records(response: bytes, ident: int) -> list[str]:
    try:
        answer_id, flags, questions, answers = struct.unpack("!HHHH", response[:8])
        if answer_id != ident or not flags & 0x8000 or flags & 0x000F:
            return []
        offset = 12
        for _ in range(questions):
            offset = _skip_name(response, offset) + 4
        found = []
        for _ in range(answers):
            offset = _skip_name(response, offset)
            kind, _klass, _ttl, length = struct.unpack("!HHIH", response[offset:offset + 10])
            offset += 10
            if kind == 1 and length == 4:
                found.append(str(ipaddress.IPv4Address(response[offset:offset + 4])))
            offset += length
        return found
    except (IndexError, struct.error, ValueError):
        return []


def _receive(stream, size: int) -> bytes:
    data = b""
    while len(data) < size:
        chunk = stream.recv(size - len(data))
        if not chunk:
            raise OSError("short read")
        data += chunk
    return data


def resolve_encrypted(server: str, name: str) -> list[str]:
    """One A query over DNS-over-TLS or DNS-over-HTTPS with verified TLS, never via a proxy."""
    ident = secrets.randbelow(65536)
    query = _dns_question(name, ident)
    parsed = urllib.parse.urlsplit(server)
    context = ssl.create_default_context()
    if parsed.scheme == "tls":
        with socket.create_connection((parsed.hostname, parsed.port or 853), timeout=DNS_SECONDS) as raw, \
                context.wrap_socket(raw, server_hostname=parsed.hostname) as stream:
            stream.sendall(struct.pack("!H", len(query)) + query)
            response = _receive(stream, struct.unpack("!H", _receive(stream, 2))[0])
    else:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                             urllib.request.HTTPSHandler(context=context), NoRedirect())
        request = urllib.request.Request(server, data=query, headers={
            "Content-Type": "application/dns-message", "Accept": "application/dns-message"})
        with opener.open(request, timeout=DNS_SECONDS) as reply:
            response = reply.read(65536)
    return _a_records(response, ident)


def resolve_system(name: str) -> list[str]:
    infos = socket.getaddrinfo(name, None, socket.AF_INET, socket.SOCK_STREAM)
    return sorted({info[4][0] for info in infos})


def tcp_connect(address: str, port: int) -> str:
    try:
        with socket.create_connection((address, port), timeout=CONNECT_SECONDS):
            return "connect_ok"
    except (socket.timeout, TimeoutError):
        return "connect_timeout"
    except OSError:
        return "connect_failed"


def diagnose(paths: Paths) -> dict:
    """Content-free reachability counts for the installed config; never prints names or addresses."""
    with PrivateDirectory(paths.config_dir) as config:
        raw = config.read("config.json", optional=True)
    if raw is None:
        raise ProxyError("not_configured")
    try:
        current = json.loads(raw)
        node_types = counts(current)
        policy = (current.get("dns") or {}).get("proxy-server-nameserver-policy") or {}
        if not isinstance(policy, dict):
            raise ValueError
        endpoints = sorted({(node["server"], node["port"]) for node in current["proxies"]
                            if node["type"] == "anytls"})
    except (ValueError, KeyError, TypeError, AttributeError):
        raise ProxyError("state_invalid") from None
    names = sorted({server for server, _ in endpoints if _domain(server)})

    def provider(name):
        for pattern, servers in policy.items():
            if _pattern_covers(pattern, _domain(name)):
                for server in servers:
                    try:
                        found = resolve_encrypted(server, name)
                    except (OSError, ValueError, ssl.SSLError, ProxyError):
                        continue
                    if found:
                        return found
                return []
        return None

    def system(name):
        try:
            return resolve_system(name)
        except OSError:
            return []

    with ThreadPoolExecutor(max_workers=16) as pool:
        by_system = dict(zip(names, pool.map(system, names)))
        by_provider = dict(zip(names, pool.map(provider, names)))
        methods = {"system": by_system, "provider_dns": by_provider}
        result = {}
        for method, answers in methods.items():
            tally = {"covered": 0, "resolved": 0, "unresolved": 0,
                     "connect_ok": 0, "connect_timeout": 0, "connect_failed": 0}
            targets = []
            for server, port in endpoints:
                found = answers.get(server, [server]) if _domain(server) else [server]
                if found is None:
                    continue
                tally["covered"] += 1
                if not found:
                    tally["unresolved"] += 1
                    continue
                tally["resolved"] += 1
                targets.append((found[0], port))
            for outcome in pool.map(lambda target: tcp_connect(*target), targets):
                tally[outcome] += 1
            result[method] = tally
    differing = sum(1 for name in names if by_provider.get(name)
                    and set(by_provider[name]) != set(by_system.get(name) or ()))
    try:
        verify_proxy()
        through_proxy = True
    except ProxyError:
        through_proxy = False
    return {"schema_version": 1, "status": "diagnosed", "code": "ok",
            "node_count": sum(node_types.values()), "node_types": node_types,
            "tcp_endpoints": len(endpoints), "names": len(names), "provider_policies": len(policy),
            "names_with_different_answers": differing, "resolution": result,
            "proxy_https_verified": through_proxy}


def child_environment() -> dict[str, str]:
    environment = {key: value for key, value in os.environ.items() if not key.lower().endswith("_proxy")}
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        environment[key] = "http://127.0.0.1:7890"
    environment["NO_PROXY"] = environment["no_proxy"] = BYPASS
    return environment


@contextmanager
def update_signals():
    def interrupted(*_):
        raise ProxyError("interrupted")

    previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        yield
    finally:
        signal.signal(signal.SIGTERM, previous)


def main(argv: list[str] | None = None) -> int:
    parser = SafeArgumentParser(description="Private localhost Mihomo management; never displays configuration.")
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("update", help="Validate and atomically update the private subscription.")
    commands.add_parser("status", help="Print content-free status JSON.")
    commands.add_parser("diagnose", help="Print content-free node reachability counts (no addresses).")
    run_parser = commands.add_parser("run", help="Set proxy environment only for a child command.")
    run_parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.action == "run":
            command = args.command
            if command and command[0] == "--":
                command = command[1:]
            if not command:
                raise ProxyError("command_required")
            try:
                result = subprocess.run(command, env=child_environment())
            except OSError:
                raise ProxyError("command_failed") from None
            return result.returncode if result.returncode >= 0 else 128 - result.returncode
        paths = Paths(Path.home())
        if args.action == "update":
            with update_signals():
                result = update(paths)
        elif args.action == "diagnose":
            result = diagnose(paths)
        else:
            result = status(paths)
        print(encode(result).decode("utf-8"), end="")
        return 0 if result["status"] != "failed" else 1
    except (KeyboardInterrupt, Exception) as failure:
        if isinstance(failure, ProxyError) and failure.result is not None:
            print(encode(failure.result).decode("utf-8"), end="")
            return 1
        if isinstance(failure, KeyboardInterrupt):
            code = "interrupted"
        elif isinstance(failure, ProxyError):
            code = failure.code
        elif isinstance(failure, OSError):
            code = "filesystem_failed"
        else:
            code = "internal_error"
        print(encode(report("failed", code)).decode("utf-8"), end="")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
