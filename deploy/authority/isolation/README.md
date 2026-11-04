# Rootless physical isolation

This directory owns only launch policy, user-unit sources, fixed runtime wrappers,
and synthetic tests. Nothing here installs units, enables linger, invokes sudo,
initializes a profile, or changes a running service. Bootstrap/build and the
`run-capability.mjs` supervisor live one directory above and are separate concerns.

## Fixed layout

Host defaults (overridable as launcher flags before the role):

| Flag | Default |
| --- | --- |
| `--base` | `$HOME/.local/share/companion-authority-v1` |
| `--release` | `$HOME/src/dsh-companion/authority-0.4.0` |
| `--runtime` | `$HOME/.local/opt/companion` |
| `--ops` | `$HOME/src/dsh-companion/authority-ops-0.4.0` |

Copy the **whole** parent operations directory to `--ops`, including this
`isolation/` directory. The release and operations trees must contain code only,
not operator credentials, database snapshots, or unrelated host configuration.
The broad read-only `/usr` runtime tree also needs an operator secret audit.

| Host object below `--base` | Authority | DSH / maintenance |
| --- | --- | --- |
| `operator/authority.json` | `/authority/config.json`, RO file only | absent |
| `operator/admin.token`, `operator/reading.token` | absent | absent |
| `authority-data/` | `/authority/state`, RW | absent |
| `ipc/authority/` | `/authority/ipc`, RW | `/run/companion`, RO |
| `ipc/web/dsh-http.sock` | absent | inherited listening FD3 only |
| `dsh-home/` | absent | `/home/companion/dsh`, RW |
| `dsh-config/` | absent | `/home/companion/config`, RO |

Both roles see read-only release at `/opt/companion/release` and pinned runtime at
`/opt/companion/runtime`. Only DSH sees read-only ops at `/opt/companion/ops`.
The authority JSON must use `databasePath=/authority/state/authority.sqlite` and
`socketPath=/authority/ipc/authority.sock`; credential hashes belong in that JSON,
never raw admin/reading token files. The capability adapter must use
`/run/companion/authority.sock` and its capability token under
`/home/companion/config`. Mounting a socket directory RO permits connecting to its
sockets but prevents replacing/creating directory entries. The authority still
must enforce capabilities; same-UID socket peer identity is not admin authority.

## Commands

All required directories/files must already exist. Launchers fail rather than
create a new or empty profile on every boot.

```sh
OPS="$HOME/src/dsh-companion/authority-ops-0.4.0"
python3 "$OPS/isolation/launch.py" authority
# Requires exactly one systemd listening AF_UNIX socket on FD3:
python3 "$OPS/isolation/launch.py" capability
# Manual initialization / official CLI management in the SAME private sandbox:
python3 "$OPS/isolation/launch.py" dsh -- --help
# Pass supported official DSH CLI arguments after '--'. The local bundle is:
# /opt/companion/release/capability-bundle
```

Authority runs pinned Node 24.22.2 with
`/opt/companion/release/authority/src/main.js --config /authority/config.json`.
The capability role runs pinned Node with `/opt/companion/ops/run-capability.mjs`.
The maintenance role runs pinned Node with DSH's actual `lib/bin.js`, not host
absolute-prefix wrappers. `bin/dsh`, `bin/pnpm`, `bin/npm` provide the same fixed
inside paths for subprocesses; preserve their executable modes when copying.

Private networking also applies to initialization/plugin management: only offline,
fully bundled local package operations can work. There is intentionally no
maintenance network bypass and no model/API/proxy credentials. `DSH_HOME` and all
XDG cache/config/data paths point into the persistent isolated DSH home. Profiles
are not reset by any launcher or unit.

## Socket activation and supervisor contract

```text
browser -> host 127.0.0.1:3081
        -> companion-dsh-public.socket / public.service (outer proxyd)
        -> host ipc/web/dsh-http.sock
        -> companion-dsh-internal.socket / internal.service
        -> bwrap (FD3 preserved)
        -> inner proxyd -> private 127.0.0.1:3080 DSH
                             |
                             +-> /run/companion/authority.sock
                                      -> separate authority bwrap -> private DB
```

The five unit sources are under `units/`; they are not installed by this code.
`Accept=no` passes one listening descriptor, not one connected descriptor.
`Sockets=` names **only** the matching socket. The public TCP descriptor must never
be given to the sandbox. Starting the public socket is enough for on-demand
activation: outer service requires the internal socket; its UDS connection starts
the internal service, which requires the authority service. `Type=exec` is used,
not an unsupported `notify` claim. Authority `After=` does not establish readiness.

`run-capability.mjs` must:

1. Bounded-wait for authority UDS connectivity, then start DSH on private
   `127.0.0.1:3080`, advertising `http://127.0.0.1:3081` and trusting that public
   browser Host/Origin as appropriate. DSH receives no FD3.
2. Bounded-wait for DSH TCP readiness before starting the inner proxy. This lets
   the already-listening UDS queue the first browser request during startup.
3. Spawn `/bin/sh -c 'LISTEN_PID=$$; export LISTEN_PID; exec
   /usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:3080'` with Node stdio
   `['ignore', 'inherit', 'inherit', 3]`, env `LISTEN_FDS=1`, and no
   `LISTEN_PIDFDID`. The launcher clears all ambient activation env on purpose.
   A *new* shell then `exec` supplies the correct namespace PID; setting `$$` in a
   parent shell background subshell is not reliable.
4. Close supervisor FD3 after spawning the proxy. DSH, its tools, readiness probes,
   and maintenance children must never inherit that listener. Reap both children,
   and stop the sibling if either fails or exits. Units use control-group cleanup.

The installed bubblewrap 0.11.1 has **no `--preserve-fds` option**. Non-CLOEXEC FD3
survives normal bwrap execution, verified by the probe. The outer launcher validates
AF_UNIX/SOCK_STREAM/listening/non-abstract FD3, checks activation PID/count, closes
all inherited descriptors above FD3, then execs bwrap with only a minimal host PATH.
Authority and maintenance close every inherited descriptor above stderr. bwrap
sets a fresh environment and never imports host HOME, tokens, DBus, agent, proxy,
or model credentials. All roles get private user/PID/network/IPC/UTS namespaces,
new proc/dev, dropped capabilities, disabled nested user namespaces, and a new
session. Host `/run`, `/proc`, `/tmp`, `/home`, DBus, SSH agent and user-manager
socket trees are not mounted. Only `/etc/ld.so.cache`, when present, is bound from
host `/etc`; no host passwd, resolver, or machine identity is exposed.

## Validation (no deployment)

```sh
python3 -B -m unittest discover -s "$OPS/isolation/tests" -v
python3 -B "$OPS/isolation/probe.py"          # Linux VM only
systemd-analyze --user verify "$OPS"/isolation/units/*
```

The probe uses the **real launch.py** with temporary synthetic pinned-node/code
fixtures delegating to Python. It checks both role mount policies, outside read
and write denial, admin/reading/database absence in capability, capability-token
absence in authority, fresh proc/PID and environment, zero capabilities, denied
nested userns, denied host TCP and abstract UDS against live synthetic listeners,
authority UDS connectivity, RO token/socket-directory writes, persistent profile
and authority-state writes, and HTTP 200 over TCP -> UDS -> sandbox loopback.
It uses ephemeral host ports, never 3081; it installs no units. Every fixture path
is verified absolute and owned before cleanup; all started process groups are
terminated and reaped. No real profile, secrets, database, or old service is read.

Acceptance prerequisites: Ubuntu ARM64 unprivileged user namespaces/bwrap must
work; systemd user manager and socket-proxyd must exist; the pinned runtime and
release/ops must be complete and code-only; bootstrap must populate the exact
private layout and config paths; the supervisor must obey the FD/readiness
contract; production initialization/package install must remain offline. A rootless
user service runs while its user manager is alive: this code does not enable
linger or promise boot-time operation after logout. Synthetic proof is not a
claim that the real Authority/DSH integration has already been deployed or tested.
