#!/usr/bin/python3
"""Rootless role launcher. Does not initialize profiles or manage user services."""
import argparse
import os
from pathlib import Path
import socket
import sys

PREFIX = '/opt/companion'
NODE = PREFIX + '/runtime/node-v24.22.2-linux-arm64/bin/node'
DSH = PREFIX + '/runtime/dsh-0.2.1-rc.3/node_modules/@deepseek-ai/dsh/lib/bin.js'


def existing(path, directory=True):
    path = Path(path).resolve(strict=True)
    if directory != path.is_dir():
        raise ValueError('expected ' + ('directory: ' if directory else 'file: ') + str(path))
    return str(path)


def build_command(role, base, release, runtime, ops, arguments=()):
    """Build an allowlisted mount tree; no ambient HOME, /run, /etc or host /proc."""
    if role not in ('authority', 'capability', 'dsh'):
        raise ValueError('unknown role')
    base, release, runtime = (existing(p) for p in (base, release, runtime))
    args = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-net',
            '--unshare-ipc', '--unshare-uts', '--disable-userns', '--die-with-parent',
            '--new-session', '--cap-drop', 'ALL', '--clearenv',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
            '--symlink', 'usr/lib', '/lib', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/tmp', '--tmpfs', '/run',
            '--ro-bind', release, PREFIX + '/release',
            '--ro-bind', runtime, PREFIX + '/runtime']
    # Dynamic linking needs this cache on some distributions, but no host /etc tree.
    if Path('/etc/ld.so.cache').is_file():
        args += ['--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache']
    env = {'PATH': PREFIX + '/runtime/node-v24.22.2-linux-arm64/bin:/usr/bin:/bin',
           'LANG': 'C.UTF-8', 'TZ': 'America/New_York', 'HOME': '/tmp'}
    if role == 'authority':
        if arguments:
            raise ValueError('authority does not accept arbitrary command arguments')
        args += ['--bind', existing(base + '/authority-data'), '/authority/state',
                 '--bind', existing(base + '/ipc/authority'), '/authority/ipc',
                 '--bind', existing(base + '/ipc/operator'), '/authority/operator',
                 '--ro-bind', existing(base + '/ipc/model-control'), '/authority/model-control',
                 '--ro-bind', existing(base + '/ipc/qq-control'), '/authority/qq-control',
                 '--ro-bind', existing(base + '/operator/authority.json', False), '/authority/config.json',
                 '--chdir', '/authority/state']
        if Path(base + '/authority-content/control.token').is_file():
            args += ['--ro-bind', existing(base + '/ipc/content'), '/authority/content-ipc',
                     '--ro-bind', existing(base + '/authority-content'), '/authority/content-config']
        command = [NODE, PREFIX + '/release/authority/src/main.js', '--config', '/authority/config.json']
    else:
        ops = existing(ops)
        args += ['--ro-bind', ops, PREFIX + '/ops',
                 '--ro-bind', existing(base + '/ipc/authority'), '/run/companion',
                 '--ro-bind', existing(base + '/ipc/model'), '/run/companion-model',
                 '--bind', existing(base + '/dsh-home'), '/home/companion/dsh',
                 '--ro-bind', existing(base + '/dsh-config'), '/home/companion/config',
                 '--ro-bind', existing(base + '/qq-worker'), '/home/companion/qq-worker',
                 '--ro-bind', existing(base + '/qq-inbox'), '/home/companion/qq-inbox',
                 '--chdir', '/home/companion/dsh']
        env.update({'HOME': '/home/companion', 'DSH_HOME': '/home/companion/dsh',
                    'XDG_CACHE_HOME': '/home/companion/dsh/cache',
                    'XDG_CONFIG_HOME': '/home/companion/dsh/config',
                    'XDG_DATA_HOME': '/home/companion/dsh/data',
                    'COMPANION_DSH_CONFIG_FILE': '/home/companion/config/adapter.json',
                    'COMPANION_QQ_WORKER_CONFIG': '/home/companion/qq-worker/route.json',
                    'COMPANION_MODEL_GATEWAY_TOKEN': Path(existing(base + '/dsh-config/model-gateway.token', False)).read_text().strip(),
                    'PATH': PREFIX + '/ops/isolation/bin:' + env['PATH']})
        if role == 'capability':
            if arguments:
                raise ValueError('capability supervisor does not accept arbitrary arguments')
            command = [NODE, PREFIX + '/ops/run-capability.mjs']
        else:
            command = [NODE, DSH, *arguments]
    for key, value in env.items():
        args += ['--setenv', key, value]
    return args + ['--', *command]


def check_activation():
    if os.environ.get('LISTEN_FDS') != '1' or os.environ.get('LISTEN_PID') != str(os.getpid()):
        raise ValueError('capability requires exactly one systemd activation descriptor for this PID')
    # Duplicate solely for inspection, so the original fd3 is not closed by Python.
    with socket.socket(fileno=os.dup(3)) as listener:
        if listener.family != socket.AF_UNIX or listener.type != socket.SOCK_STREAM or not listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN):
            raise ValueError('fd3 must be a listening named Unix stream socket')
        name = listener.getsockname()
        if not isinstance(name, str) or not name.startswith('/'):
            raise ValueError('fd3 must not be an abstract socket')
    os.set_inheritable(3, True)


def main():
    home = Path.home()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default=str(home / '.local/share/companion-world-v1'))
    parser.add_argument('--release', default=str(home / 'src/dsh-companion/current'))
    parser.add_argument('--runtime', default=str(home / '.local/opt/companion'))
    parser.add_argument('--ops', default=str(home / 'src/dsh-companion/current/ops'))
    parser.add_argument('role', choices=['authority', 'capability', 'dsh'])
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    options = parser.parse_args()
    arguments = options.arguments
    if arguments[:1] == ['--']:
        arguments = arguments[1:]
    try:
        command = build_command(options.role, options.base, options.release, options.runtime, options.ops, arguments)
        if options.role == 'capability':
            check_activation()
        # Do not carry arbitrary inherited host handles into either role.
        os.closerange(4 if options.role == 'capability' else 3, 1048576)
        os.execve(command[0], command, {'PATH': '/usr/bin:/bin'})
    except (OSError, ValueError) as error:
        print('isolation launcher: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
