#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [action, scope] = process.argv.slice(2);
const scopes = new Set(['authority', 'qq', 'speech', 'media', 'memory', 'console', 'git', 'all']);
if (action !== 'status' && (action !== 'check' || !scopes.has(scope))) {
  console.error('Usage: node scripts/vm.mjs status | check authority|qq|speech|media|memory|console|git|all'); process.exit(2);
}
const prefix = 'export PATH="$HOME/.local/opt/companion/bin:$PATH"; cd "$HOME/work/big-fat-fish" && ';
const command = action === 'status'
  ? prefix + 'git log -1 --format=%h && git status --short && "$HOME/.local/opt/companion/bin/node" --version'
  : prefix + '"$HOME/.local/opt/companion/bin/node" --run ' + (scope === 'all' ? 'test' : 'test:' + scope);
const result = spawnSync('ssh', ['-4', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'myvm', command], { encoding: 'utf8', timeout: action === 'status' ? 20000 : 180000, maxBuffer: 4 * 1024 * 1024 });
const text = (result.stdout || '') + (result.stderr || '');
if (result.status === 0) {
  console.log(JSON.stringify({ ok: true, action, ...(scope ? { scope } : {}), summary: text.trim().split('\n').filter(Boolean).slice(-10) }));
} else {
  fs.mkdirSync(new URL('../.build/', import.meta.url), { recursive: true });
  const file = new URL('../.build/vm-' + action + '-' + (scope || 'status') + '.log', import.meta.url);
  fs.writeFileSync(file, text, { mode: 0o600 });
  console.error(JSON.stringify({ ok: false, action, exit: result.status, code: result.error?.code, log: fileURLToPath(file) }));
  process.exitCode = 1;
}
