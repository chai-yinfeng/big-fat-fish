# Rootless isolation and user units

This directory owns the Authority launch policy, the user-unit sources and
synthetic tests. Nothing here installs units, enables linger, invokes sudo,
initializes data or changes a running service. Bootstrap/build live one directory
above; `companion-deploy` installs the units of a release.

## Fixed layout

Host defaults (overridable as launcher flags before the role):

| Flag | Default |
| --- | --- |
| `--base` | `$HOME/.local/share/companion-world-v1` |
| `--release` | `$HOME/src/companion/current` (symlink switched by `companion-deploy`) |
| `--runtime` | `$HOME/.local/opt/companion` |
| `--ops` | `$HOME/src/companion/current/ops` (accepted, not mounted) |

The release and operations trees must contain code only, not operator
credentials, database snapshots, or unrelated host configuration. The broad
read-only `/usr` runtime tree also needs an operator secret audit.

| Host object below `--base` | Authority sandbox |
| --- | --- |
| `operator/authority.json` | `/authority/config.json`, RO file only |
| `operator/admin.token`, other tokens | absent |
| `authority-data/` | `/authority/state`, RW |
| `ipc/authority/`, `ipc/operator/` | `/authority/ipc`, `/authority/operator`, RW |
| `ipc/model-control/`, `ipc/qq-control/` | RO (connect only) |
| `ipc/content/`, `authority-content/` | RO, only once content is prepared |

The Authority sees the read-only release at `/opt/companion/release` and the
pinned runtime at `/opt/companion/runtime`. The authority JSON must use
`databasePath=/authority/state/authority.sqlite` and
`socketPath=/authority/ipc/authority.sock`; credential hashes belong in that JSON,
never raw tokens. Mounting a socket directory RO permits connecting to its sockets
but prevents replacing/creating directory entries. Same-UID socket peer identity
is not admin authority; the Authority still enforces capabilities.

```sh
python3 "$OPS/isolation/launch.py" authority
```

It runs pinned Node 24.22.2 with
`/opt/companion/release/authority/src/main.js --config /authority/config.json` in
private user/PID/network/IPC/UTS namespaces with new proc/dev, dropped
capabilities, disabled nested user namespaces, a cleared environment and a new
session. Host `/run`, `/proc`, `/tmp`, `/home`, DBus, SSH agent and user-manager
socket trees are not mounted; only `/etc/ld.so.cache`, when present, is bound
from host `/etc`. Every inherited descriptor above stderr is closed.

## Other units

The conversation executor (`companion-conversation.service`) is not wrapped in
bwrap and runs as the companion user **without filesystem isolation**. On
home-agent (systemd 255, `apparmor_restrict_unprivileged_userns=1`) an
unprivileged user manager silently skips mount/namespace options (ProtectSystem,
ReadWritePaths, InaccessiblePaths, PrivateTmp, PrivateNetwork, also with
PrivateUsers), so the unit lists only options that take effect: `NoNewPrivileges`
and seccomp/prctl-based `RestrictAddressFamilies=AF_UNIX` (network limited to Unix
sockets), `SystemCallArchitectures=native`, `LockPersonality`, `RestrictRealtime`,
`RestrictSUIDSGID`, plus `UMask`. The model can reach only `companion_scope` and
`companion_content`, which have no filesystem access. `companion-qq.service` requires the conversation service. Ports:
3082 is the only companion-owned TCP listener (`companion-world-public.socket`).

## Validation (no deployment)

```sh
python3 -B -m unittest discover -s "$OPS/isolation/tests" -v
python3 -B "$OPS/isolation/probe.py"          # Linux host only
systemd-analyze --user verify "$OPS"/isolation/units/*
```

The probe runs the **real launch.py** with a temporary synthetic pinned-node
fixture delegating to Python. It checks the Authority mount policy, outside read
and write denial, admin/reading token absence, fresh proc/PID and environment,
zero capabilities, denied nested userns, denied host TCP and abstract UDS against
live synthetic listeners, RO config, and persistent state writes. It installs no
units and reads no real profile, secret or database. Synthetic proof is not a
claim that the real deployment has been tested.
