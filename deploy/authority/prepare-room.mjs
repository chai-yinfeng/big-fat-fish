#!/usr/bin/env node
// Gives an EXISTING world the room page's read-only credential. Run once as the world owner; safe to run again.
//   <base>/room-config/room.token          the token (0600), read only by the room page server (room/serve.mjs)
//   <base>/operator/room-credential.json   its sha256, read by Authority at start (restart Authority afterwards)
// The hash is NOT added to authority.json: a release from before the room role refuses a configuration that lists a
// `room` credential, and never reads this separate file, so `companion-deploy rollback` works without an edit.
// Prints file-level facts only; never the token or its hash.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function prepareRoom(base = path.join(os.homedir(), '.local/share/companion-world-v1')) {
  const authority = JSON.parse(fs.readFileSync(path.join(base, 'operator/authority.json'), 'utf8'));
  if (!Array.isArray(authority.credentials) || authority.credentials.some(row => row?.role === 'room')) throw new Error('ROOM_CREDENTIAL_INLINE');
  fs.mkdirSync(path.join(base, 'room-config'), { recursive: true, mode: 0o700 });
  const tokenFile = path.join(base, 'room-config/room.token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  const hash = createHash('sha256').update(fs.readFileSync(tokenFile, 'utf8').trim()).digest('hex');
  const hashFile = path.join(base, 'operator/room-credential.json');
  const previous = fs.existsSync(hashFile) ? JSON.parse(fs.readFileSync(hashFile, 'utf8')) : null;
  if ((previous && previous.hash !== hash) || authority.credentials.some(row => row?.hash === hash)) throw new Error('ROOM_CREDENTIAL_CONFLICT');
  if (!previous) {
    const temporary = hashFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, hash }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, hashFile);
  }
  return { prepared: true, credentialPreserved: Boolean(previous), authorityRestartRequired: !previous, worldNotReset: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.umask(0o077);
  try { process.stdout.write(JSON.stringify(prepareRoom()) + '\n'); }
  catch { process.stderr.write('Room preparation failed; existing world was not reset.\n'); process.exitCode = 1; }
}
