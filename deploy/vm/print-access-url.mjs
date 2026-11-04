#!/usr/bin/env node
// Human terminal only: output includes a private process-token URL. Never log or share it.
import fs from 'node:fs';
import path from 'node:path';
const home = process.env.DSH_HOME || path.join(process.env.HOME, '.local/share/dsh-companion-base');
const file = path.join(home, 'run/local-access.json');
if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error('Access record is not private');
const access = JSON.parse(fs.readFileSync(file, 'utf8'));
if (access.purpose !== 'companion-local-access') throw new Error('Unknown access record');
const url = new URL(access.origin);
url.searchParams.set('token', access.token);
console.log(url.href);
