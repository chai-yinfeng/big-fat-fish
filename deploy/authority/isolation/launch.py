#!/usr/bin/python3
"""Rootless Authority launcher. Does not initialize data or manage user services."""
import argparse
import os
from pathlib import Path
import platform
import sys

PREFIX = '/opt/companion'


def node_arch(machine=None):
    """Map the host machine name to the official Node archive architecture."""
    machine = machine or platform.machine()
    if machine in ('aarch64', 'arm64'):
        return 'arm64'
    if machine in ('x86_64', 'amd64'):
        return 'x64'
    raise ValueError('unsupported machine: ' + machine)


NODE_HOME = PREFIX + '/runtime/node-v24.22.2-linux-' + node_arch()
NODE = NODE_HOME + '/bin/node'


def existing(path, directory=True):
    path = Path(path).resolve(strict=True)
    if directory != path.is_dir():
        raise ValueError('expected ' + ('directory: ' if directory else 'file: ') + str(path))
    return str(path)


def build_command(role, base, release, runtime, ops, arguments=()):
    """Build an allowlisted mount tree; no ambient HOME, /run, /etc or host /proc."""
    if role != 'authority':
        raise ValueError('unknown role')
    if arguments:
        raise ValueError('authority does not accept arbitrary command arguments')
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
    env = {'PATH': NODE_HOME + '/bin:/usr/bin:/bin',
           'LANG': 'C.UTF-8', 'TZ': 'America/New_York', 'HOME': '/tmp'}
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
    for key, value in env.items():
        args += ['--setenv', key, value]
    return args + ['--', *command]


def main():
    home = Path.home()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default=str(home / '.local/share/companion-world-v1'))
    parser.add_argument('--release', default=str(home / 'src/dsh-companion/current'))
    parser.add_argument('--runtime', default=str(home / '.local/opt/companion'))
    parser.add_argument('--ops', default=str(home / 'src/dsh-companion/current/ops'))
    parser.add_argument('role', choices=['authority'])
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    options = parser.parse_args()
    arguments = options.arguments
    if arguments[:1] == ['--']:
        arguments = arguments[1:]
    try:
        command = build_command(options.role, options.base, options.release, options.runtime, options.ops, arguments)
        # Do not carry arbitrary inherited host handles into the sandbox.
        os.closerange(3, 1048576)
        os.execve(command[0], command, {'PATH': '/usr/bin:/bin'})
    except (OSError, ValueError) as error:
        print('isolation launcher: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
