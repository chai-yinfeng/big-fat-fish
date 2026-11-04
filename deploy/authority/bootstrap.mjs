#!/usr/bin/env node
// First initialization on VM. Never run inside the model namespace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { prepareModel } from './prepare-model.mjs';
import { prepareQQ } from './prepare-qq.mjs';
process.umask(0o077);
const base = path.join(os.homedir(), '.local/share/companion-world-v1');
if (fs.existsSync(base)) throw new Error('Refusing to reset an existing world');
for (const relative of ['operator', 'authority-data', 'ipc/authority', 'ipc/operator', 'ipc/web', 'dsh-home', 'dsh-config']) fs.mkdirSync(path.join(base, relative), { recursive: true, mode: 0o700 });
const token = () => randomBytes(32).toString('base64url');
const admin = token(), source = token(), operator = token();
const hash = value => createHash('sha256').update(value).digest('hex');
function write(relative, value) { fs.writeFileSync(path.join(base, relative), typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
write('operator/admin.token', admin);
write('operator/console.token', operator);
write('dsh-config/capability.token', source);
write('operator/authority.json', {
  schemaVersion: 1, initialPaused: true,
  databasePath: '/authority/state/authority.sqlite', socketPath: '/authority/ipc/authority.sock',
  operator: { socketPath: '/authority/operator/operator.sock', tokenHash: hash(operator), origins: ['http://127.0.0.1:3081', 'http://localhost:3081', 'http://127.0.0.1:3082', 'http://localhost:3082'] },
  credentials: [
    { hash: hash(admin), role: 'admin' },
    { hash: hash(source), role: 'capability', capabilityId: 'dsh-test' },
  ],
  capabilities: [{ id: 'dsh-test', policy: 'conversation.v1' }],
  actors: [{ capabilityId: 'dsh-test', externalActorId: 'test-owner', personId: 'person:owner' }],
  streams: [],
  persona: { name: '大肥鱼' },
});
write('dsh-config/adapter.json', {
  socketPath: '/run/companion/authority.sock', tokenFile: '/home/companion/config/capability.token',
  actorId: 'test-owner', deliveryFile: '/home/companion/dsh/conversation-delivery.json',
});
prepareModel(base);
prepareQQ(base);
console.log(JSON.stringify({ initialized: true, base, paused: true, memoryMigrated: false, realAccountsConfigured: false }));
