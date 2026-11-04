#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectWeb } from './web-rpc.mjs';

// Type=exec is process admission, not API readiness. Authenticate the current
// access record before the QQ ingress can accept any model work.
const file = path.join(os.homedir(), '.local/share/companion-world-v1/dsh-home/run/local-access.json');
const deadline = Date.now() + 60000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const rpc = await connectWeb(JSON.parse(fs.readFileSync(file, 'utf8')));
    const inventory = await rpc('pluginInventory/list');
    if (inventory.entries.some(row => row.moduleName === '@local/companion' && row.enabled && row.fiberPhase === 'active')) { ready = true; break; }
  } catch {}
  await delay(500);
}
if (ready) process.stdout.write('SDK execution endpoint ready.\n');
else { process.stderr.write('SDK execution endpoint not ready; QQ ingress will retry with the service.\n'); process.exitCode = 1; }
