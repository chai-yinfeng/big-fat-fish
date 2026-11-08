#!/usr/bin/env node
// Runs on the production host as companion (authority socket). Against the
// production world only the read-only `status` mode exists: it prints Authority
// health and nothing else. Mutating synthetic acceptance belonged to the retired
// DSH runtime and was removed with it.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const base = '/home/companion/.local/share/companion-world-v1';
const mode = process.argv[2] || 'status';
if (mode !== 'status') { process.stderr.write('Live acceptance refused: PRODUCTION_WORLD_STATUS_ONLY\n'); process.exit(2); }
const socketPath = path.join(base, 'ipc/authority/authority.sock');
function health() {
  const token = fs.readFileSync(path.join(base, 'operator/admin.token'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'GET', path: '/v1/health', agent: false, headers: { authorization: `Bearer ${token}` } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { reject(new Error('VERIFY_OUTPUT_LIMIT')); res.destroy(); return; } chunks.push(chunk); });
      res.on('error', () => reject(new Error('VERIFY_TRANSPORT')));
      res.on('end', () => { try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (res.statusCode !== 200 || body.ok !== true) throw new Error(); resolve(body.value); } catch { reject(new Error('VERIFY_RESPONSE')); } });
    });
    req.setTimeout(10000, () => req.destroy()); req.on('error', () => reject(new Error('VERIFY_TRANSPORT'))); req.end();
  });
}
try { console.log(JSON.stringify(await health())); }
catch (error) { process.stderr.write('Live status failed: ' + (error.message || 'CHECK_FAILED') + '\n'); process.exitCode = 1; }
