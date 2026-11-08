#!/usr/bin/python3
"""Synthetic rootless mount/network probe; never installs or starts user units.

Runs the production launcher's mount policy with a synthetic Python payload, not
real Authority data. All fixtures and subprocesses are owned and cleaned here.
"""
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent

PAYLOAD = r'''
import errno,json,os,socket,subprocess
c=CONFIG
result={'role':c['role'],'pid':os.getpid(),'netns':os.readlink('/proc/self/ns/net'),
        'pids':[x for x in os.listdir('/proc') if x.isdecimal()]}
assert result['pid']==2 and set(result['pids'])=={'1','2'}, result
assert result['netns'] != c['host_netns']
assert 'SYNTHETIC_HOST_SECRET' not in os.environ
for key in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','DBUS_SESSION_BUS_ADDRESS','SSH_AUTH_SOCK','LISTEN_PIDFDID']:
 assert key not in os.environ, key
for path in [c['outside'],c['admin'],c['reading'],c['host_database'],'/proc/'+str(c['host_pid'])+'/root','/run/dbus/system_bus_socket']:
 assert not os.path.exists(path), path
try:
 open(c['outside'],'w').close()
 raise AssertionError('host outside write allowed')
except OSError as e:
 assert e.errno in (errno.ENOENT,errno.EACCES,errno.EROFS), e
for name,address,family in [('host_tcp',('127.0.0.1',c['host_port']),socket.AF_INET),('host_abstract',c['abstract'],socket.AF_UNIX)]:
 with socket.socket(family) as s:
  s.settimeout(.5)
  try:
   s.connect(address)
   raise AssertionError(name+' connected')
  except OSError as e:
   assert e.errno in (errno.ECONNREFUSED,errno.ENOENT,errno.ENETUNREACH,errno.EACCES), e
   result[name]='DENIED:'+str(e.errno)
try:
 os.kill(c['host_pid'],0)
 raise AssertionError('host process visible')
except ProcessLookupError:
 result['host_process']='DENIED:ESRCH'
with open('/proc/self/status') as f:
 status=f.read()
assert 'CapEff:\t0000000000000000' in status
nested=subprocess.run(['/usr/bin/unshare','--user','true'],capture_output=True)
assert nested.returncode != 0
result.update({'outside_read_write':'DENIED','host_admin_and_reading_tokens':'ABSENT','ambient_env':'CLEAN','caps':'NONE','nested_userns':'DENIED'})
if c['role']=='authority':
 assert not os.path.exists('/home/companion/config/capability.token')
 with open('/authority/config.json') as f:
  assert json.load(f)=={'synthetic':True}
 with open('/authority/state/probe.txt','w') as f:f.write('synthetic')
 with socket.socket(socket.AF_UNIX) as s:
  s.bind('/authority/ipc/probe.sock')
 try:
  open('/authority/config.json','w').close()
  raise AssertionError('config writable')
 except OSError as e:assert e.errno==errno.EROFS
 result.update({'authority_state_write':'GRANTED','authority_socket_bind':'GRANTED','config_write':'DENIED:EROFS','capability_token':'ABSENT'})
 print(json.dumps(result),flush=True)
'''


def main():
    if sys.platform != 'linux':
        raise RuntimeError('run this probe on the target Linux VM, not macOS')
    required = ['/usr/bin/bwrap', '/usr/bin/unshare']
    for path in required:
        if not os.access(path, os.X_OK):
            raise RuntimeError('missing required executable: ' + path)
    root = Path(tempfile.mkdtemp(prefix='companion-isolation-probe-', dir='/tmp')).resolve()
    owned = str(root)
    sockets = []
    try:
        for part in ['base/authority-data', 'base/ipc/authority', 'base/ipc/operator', 'base/ipc/model-control',
                     'base/ipc/qq-control', 'base/operator', 'base/service-config', 'release', 'runtime', 'ops', 'outside']:
            (root / part).mkdir(parents=True, exist_ok=True)
        files = {'base/operator/authority.json': '{"synthetic":true}', 'base/operator/admin.token': 'SYNTHETIC-ADMIN',
                 'base/operator/reading.token': 'SYNTHETIC-READING', 'base/authority-data/authority.sqlite': 'SYNTHETIC-DB',
                 'base/service-config/health.token': 'SYNTHETIC-CAPABILITY', 'outside/secret': 'SYNTHETIC-OUTSIDE'}
        for path, value in files.items():
            (root / path).write_text(value)
        abstract = '\0companion-isolation-' + str(os.getpid())
        host_abstract = socket.socket(socket.AF_UNIX)
        host_abstract.bind(abstract)
        host_abstract.listen()
        sockets.append(host_abstract)
        host_tcp = socket.socket()
        host_tcp.bind(('127.0.0.1', 0))
        host_tcp.listen()
        sockets.append(host_tcp)
        config = {'host_port': host_tcp.getsockname()[1], 'abstract': abstract, 'host_pid': os.getpid(),
                  'host_netns': os.readlink('/proc/self/ns/net'), 'outside': str(root / 'outside/secret'),
                  'admin': str(root / 'base/operator/admin.token'), 'reading': str(root / 'base/operator/reading.token'),
                  'host_database': str(root / 'base/authority-data/authority.sqlite')}
        parameters = [str(root / p) for p in ['base', 'release', 'runtime', 'ops']]
        poisoned = dict(os.environ, SYNTHETIC_HOST_SECRET='SYNTHETIC-SECRET', HTTP_PROXY='http://127.0.0.1:1',
                        DBUS_SESSION_BUS_ADDRESS='unix:abstract=synthetic', SSH_AUTH_SOCK='/tmp/synthetic')

        # A synthetic pinned-node fixture delegates to Python. Thus the REAL
        # production launcher, FD validation/closure and exec environment run too.
        synthetic = root / 'release/synthetic.py'
        synthetic.write_text('import sys\nCONFIG=' + repr(config) + '\nCONFIG["role"]="authority"\n' + PAYLOAD)
        fake_node = root / ('runtime/node-v24.22.2-linux-' + {'aarch64': 'arm64', 'x86_64': 'x64'}[platform.machine()] + '/bin/node')
        fake_node.parent.mkdir(parents=True)
        fake_node.write_text('#!/bin/sh\nexec /usr/bin/python3 /opt/companion/release/synthetic.py "$@"\n')
        fake_node.chmod(0o700)

        def command(role):
            cmd = ['/usr/bin/python3', str(ROOT / 'launch.py')]
            for flag, value in zip(['--base', '--release', '--runtime', '--ops'], parameters):
                cmd += [flag, value]
            return cmd + [role]

        completed = subprocess.run(command('authority'), env=poisoned, capture_output=True, text=True, timeout=15)
        if completed.returncode:
            raise RuntimeError('authority probe failed: ' + completed.stderr)
        print('AUTHORITY ' + completed.stdout.strip(), flush=True)
        assert (root / 'base/authority-data/probe.txt').read_text() == 'synthetic'

        assert (root / 'base/operator/admin.token').read_text() == 'SYNTHETIC-ADMIN'
        assert (root / 'outside/secret').read_text() == 'SYNTHETIC-OUTSIDE'
        print('PASS: rootless authority mount policy, private PID/network', flush=True)
    finally:
        for listener in sockets:
            listener.close()
        if not owned.startswith('/tmp/companion-isolation-probe-') or str(root.resolve()) != owned:
            raise RuntimeError('refusing cleanup of unchecked fixture path')
        shutil.rmtree(owned)
        print('CLEANED owned synthetic fixtures', flush=True)


if __name__ == '__main__':
    main()
