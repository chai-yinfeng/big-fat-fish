#!/usr/bin/python3
"""Synthetic rootless mount/network/FD3 probe; never installs or starts user units.

Runs the production launcher's mount policy with a synthetic Python payload, not
real Authority/DSH data. All fixtures and subprocesses are owned and cleaned here.
"""
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent

PAYLOAD = r'''
import errno,http.server,json,os,socket,subprocess,sys,threading
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
else:
 with socket.socket(socket.AF_UNIX) as s:
  s.connect('/run/companion/authority.sock')
 result['authority_uds']='GRANTED'
 with open('/home/companion/config/capability.token') as f:
  assert f.read()=='SYNTHETIC-CAPABILITY'
 for path in ['/run/companion/forbidden','/home/companion/config/capability.token']:
  try:
   open(path,'w').close()
   raise AssertionError('readonly mount writable: '+path)
  except OSError as e:assert e.errno==errno.EROFS
 with open('/home/companion/dsh/probe-result.json','w') as f:json.dump(result,f)
 result.update({'profile_write':'GRANTED','capability_token_read':'GRANTED','authority_directory_write':'DENIED:EROFS','capability_token_write':'DENIED:EROFS','fd3':os.readlink('/proc/self/fd/3')})
 class Handler(http.server.BaseHTTPRequestHandler):
  def do_GET(self):
   data=json.dumps(result).encode()
   self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
  def log_message(self,*args):pass
 server=http.server.ThreadingHTTPServer(('127.0.0.1',3080),Handler)
 threading.Thread(target=server.serve_forever,daemon=True).start()
 env=dict(os.environ,LISTEN_FDS='1')
 env.pop('LISTEN_PIDFDID',None)
 proxy=subprocess.Popen(['/bin/sh','-c','LISTEN_PID=$$; export LISTEN_PID; exec /usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:3080'],pass_fds=(3,),env=env)
 os.close(3)
 sys.exit(proxy.wait())
'''


def terminate(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def main():
    if sys.platform != 'linux':
        raise RuntimeError('run this probe on the target Linux VM, not macOS')
    required = ['/usr/bin/bwrap', '/usr/bin/systemd-socket-activate', '/usr/lib/systemd/systemd-socket-proxyd', '/usr/bin/unshare']
    for path in required:
        if not os.access(path, os.X_OK):
            raise RuntimeError('missing required executable: ' + path)
    root = Path(tempfile.mkdtemp(prefix='companion-isolation-probe-', dir='/tmp')).resolve()
    owned = str(root)
    processes, sockets, logs = [], [], []
    try:
        for part in ['base/authority-data', 'base/ipc/authority', 'base/ipc/web', 'base/operator',
                     'base/dsh-home', 'base/dsh-config', 'release', 'runtime', 'ops', 'outside']:
            (root / part).mkdir(parents=True, exist_ok=True)
        files = {'base/operator/authority.json': '{"synthetic":true}', 'base/operator/admin.token': 'SYNTHETIC-ADMIN',
                 'base/operator/reading.token': 'SYNTHETIC-READING', 'base/authority-data/authority.sqlite': 'SYNTHETIC-DB',
                 'base/dsh-config/capability.token': 'SYNTHETIC-CAPABILITY', 'outside/secret': 'SYNTHETIC-OUTSIDE'}
        for path, value in files.items():
            (root / path).write_text(value)
        authority = socket.socket(socket.AF_UNIX)
        authority.bind(str(root / 'base/ipc/authority/authority.sock'))
        authority.listen(8)
        sockets.append(authority)
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
        synthetic.write_text('import sys\nCONFIG=' + repr(config) + '\nCONFIG["role"]="authority" if "--config" in sys.argv else "capability"\n' + PAYLOAD)
        fake_node = root / 'runtime/node-v24.22.2-linux-arm64/bin/node'
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

        inner_log = open(root / 'inner.log', 'w+')
        logs.append(inner_log)
        inner = subprocess.Popen(['/usr/bin/systemd-socket-activate', '--now', '-l', str(root / 'base/ipc/web/dsh-http.sock'),
                                  *command('capability')], env=poisoned, stdout=inner_log, stderr=inner_log, start_new_session=True)
        processes.append(inner)
        deadline = time.monotonic() + 10
        while not (root / 'base/dsh-home/probe-result.json').exists():
            if inner.poll() is not None or time.monotonic() > deadline:
                inner_log.seek(0)
                raise RuntimeError('capability startup failed: ' + inner_log.read()[-5000:])
            time.sleep(.05)
        # Let socket-activate bind port zero, avoiding a reserve/rebind race.
        outer_listener = socket.socket()
        outer_listener.bind(('127.0.0.1', 0))
        outer_listener.listen()
        port = outer_listener.getsockname()[1]
        outer_log = open(root / 'outer.log', 'w+')
        logs.append(outer_log)
        # Pass a pre-bound listener as fd3 to proxyd via a tiny exec-only child.
        outer_code = 'import os; fd=int(os.environ["PROBE_FD"]); os.dup2(fd,3); os.set_inheritable(3,True); os.environ.update(LISTEN_FDS="1",LISTEN_PID=str(os.getpid())); os.environ.pop("LISTEN_PIDFDID",None); os.execv("/usr/lib/systemd/systemd-socket-proxyd",["systemd-socket-proxyd",os.environ["PROBE_TARGET"]])'
        outer = subprocess.Popen(['/usr/bin/python3', '-c', outer_code], pass_fds=(outer_listener.fileno(),),
                                 env={'PROBE_FD': str(outer_listener.fileno()), 'PROBE_TARGET': str(root / 'base/ipc/web/dsh-http.sock')},
                                 stdout=outer_log, stderr=outer_log, start_new_session=True)
        processes.append(outer)
        outer_listener.close()
        response = None
        for attempt in range(40):
            try:
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                connection.request('GET', '/')
                response = connection.getresponse()
                body = response.read().decode()
                connection.close()
                break
            except OSError:
                if attempt == 39:
                    raise
                time.sleep(.05)
        assert response.status == 200, (response.status, body)
        result = json.loads(body)
        assert result['fd3'].startswith('socket:['), result
        print('CAPABILITY_HTTP_200 ' + json.dumps(result, sort_keys=True), flush=True)
        assert (root / 'base/operator/admin.token').read_text() == 'SYNTHETIC-ADMIN'
        assert (root / 'outside/secret').read_text() == 'SYNTHETIC-OUTSIDE'
        print('PASS: rootless authority + capability mount policies, private PID/network, TCP->UDS->sandbox loopback', flush=True)
    finally:
        for process in reversed(processes):
            terminate(process)
        for stream in logs:
            stream.close()
        for listener in sockets:
            listener.close()
        if not owned.startswith('/tmp/companion-isolation-probe-') or str(root.resolve()) != owned:
            raise RuntimeError('refusing cleanup of unchecked fixture path')
        shutil.rmtree(owned)
        print('CLEANED owned synthetic fixtures and subprocesses', flush=True)


if __name__ == '__main__':
    main()
