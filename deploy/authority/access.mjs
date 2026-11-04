#!/usr/bin/env node
// HUMAN TERMINAL ONLY: deliberately prints login credentials. Do not run via agent tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const base = path.join(os.homedir(), '.local/share/companion-world-v1');
const web = JSON.parse(fs.readFileSync(path.join(base, 'dsh-home/run/local-access.json'), 'utf8'));
const operator = fs.readFileSync(path.join(base, 'operator/console.token'), 'utf8').trim();
process.stdout.write('DSH login (after SSH forwarding ports 3081 and 3082):\n' + web.origin + '/?token=' + encodeURIComponent(web.token) + '\n\nSettings → 大肥鱼世界 / Companion world\nOperator access code (do not paste into AI chat):\n' + operator + '\n');
