#!/usr/bin/env node
// Rotate every internal credential of an EXISTING world in place. Never resets
// persona, memory, chats, QQ login volumes or models; never touches
// model-data/settings.json (provider keys are entered through the console).
//
// Run on the VM as the world owner while EVERY service is stopped:
//   systemctl --user stop companion-*.socket companion-*.service   (as companion)
//   docker compose -f <base>/qq-runtime/compose.yaml stop           (as root)
//   sudo -u companion <node> rotate-tokens.mjs [--base DIR] [--dry-run]
// Running services keep old hashes/tokens in memory and would fail or diverge.
// Replaced files are copied to <base>/rotation-backup-<timestamp>/ (0700) with
// their relative paths; roll back with `cp -a <backup>/. <base>/` while stopped.
// Delete the backup after verification: it holds the revoked secrets.
// Output is a JSON summary of file names only; values and hashes are never printed.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const base64url = () => randomBytes(32).toString('base64url');
const hex = () => randomBytes(32).toString('hex');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const credentialCount = (predicate) => (json, hash) => Array.isArray(json.credentials) && json.credentials.filter(row => row.hash === hash && predicate(row)).length === 1;

// Token file -> every place holding the value or its sha256 (`hashes` are edited
// here). `readers` load the file itself at start or per request: no edit needed,
// only a restart. Derived from prepare-*.mjs, deploy/qq/prepare.mjs and the
// consuming code; authority credentials are read from authority.json at start
// (authority/src/main.js -> server.js/operator.js), never persisted in sqlite.
export const INVENTORY = [
  { file: 'operator/admin.token', format: 'base64url',
    hashes: [{ file: 'operator/authority.json', field: 'credentials[role=admin].hash', check: credentialCount(row => row.role === 'admin') }],
    readers: ['operator-only verification scripts'] },
  { file: 'operator/console.token', format: 'base64url',
    hashes: [
      { file: 'operator/authority.json', field: 'operator.tokenHash', check: (json, hash) => json.operator?.tokenHash === hash },
      { file: 'operator/model-gateway.json', field: 'operatorTokenHash', check: (json, hash) => json.operatorTokenHash === hash },
      { file: 'operator/qq-bridge.json', field: 'operatorTokenHash', check: (json, hash) => json.operatorTokenHash === hash },
    ],
    readers: ['memory worker (memory-worker.json operatorTokenFile)', 'purge-execution.mjs', 'deploy/qq/*', 'open-world.mjs', 'browser console sessionStorage (re-enter)'] },
  { file: 'dsh-config/capability.token', format: 'base64url',
    hashes: [{ file: 'operator/authority.json', field: 'credentials[role=capability,capabilityId!=qq].hash', check: credentialCount(row => row.role === 'capability' && row.capabilityId !== 'qq') }],
    readers: ['DSH adapter (dsh-config/adapter.json, mounted)', 'content.json authority.tokenFile', 'model-gateway.json authority.tokenFile'] },
  { file: 'dsh-config/model-gateway.token', format: 'base64url', optional: true,
    hashes: [{ file: 'operator/model-gateway.json', field: 'inferenceTokenHash', check: (json, hash) => json.inferenceTokenHash === hash }],
    readers: ['DSH env COMPANION_MODEL_GATEWAY_TOKEN (launch.py at start)', 'content.json gateway.tokenFile', 'memory-worker.json gateway.tokenFile'] },
  { file: 'qq-worker/capability.token', format: 'base64url', optional: true,
    hashes: [{ file: 'operator/authority.json', field: 'credentials[capabilityId=qq].hash', check: credentialCount(row => row.role === 'capability' && row.capabilityId === 'qq') }],
    readers: ['qq-bridge.json authority.tokenFile', 'DSH QQ worker route.json tokenFile (mounted)'] },
  { glob: 'memory-config/*.token', format: 'base64url', optional: true,
    hashes: [{ file: 'operator/authority.json', field: 'credentials[role=maintenance].hash', check: credentialCount(row => row.role === 'maintenance') }],
    readers: ['memory-worker.json authority.tokenFile'] },
  { file: 'authority-content/control.token', format: 'base64url', optional: true, hashes: [],
    readers: ['content service control.tokenFile (hashed at start)', 'authority content.tokenFile (mounted, read per request)'] },
  { file: 'qq-runtime/private/onebot.token', format: 'hex', optional: true, hashes: [],
    plain: 'qq-runtime/data/config/onebot11*.json network.*[].token (NapCat, incl. account-named copies)',
    readers: ['qq bridge onebotTokenFile', 'deploy/qq/audition-voice.mjs'] },
  { env: 'qq-runtime/private/napcat.env', key: 'WEBUI_TOKEN', format: 'hex', optional: true, hashes: [],
    plain: 'qq-runtime/data/config/webui.json token (NapCat WebUI, authoritative after first start)',
    readers: ['NapCat container env_file', 'deploy/qq/open-login.mjs, configure-recovery.mjs (webui.json)'] },
  { yaml: 'dsh-home/.credentials.yaml', record: 'client-connection/browser-session', optional: true, hashes: [],
    readers: ['DSH BrowserAuth cookie-signing secret (loaded at Connection activation; replacing it revokes all 3081 browser cookies)'] },
];

// Directories whose files must not retain any old value afterwards (top level only).
const SCAN_DIRS = ['operator', 'dsh-config', 'qq-worker', 'memory-config', 'authority-content', 'qq-runtime', 'qq-runtime/private', 'qq-runtime/data/config', 'dsh-home', 'dsh-home/run'];
const SOCKETS = ['ipc/authority/authority.sock', 'ipc/operator/operator.sock', 'ipc/model/inference.sock', 'ipc/model-control/control.sock', 'ipc/qq-control/control.sock', 'ipc/content/content.sock'];
const PORTS = [3001, 6099, 3081, 3082];

const fail = code => { throw Object.assign(new Error(code), { rotation: true }); };
const count = (text, value) => value ? text.split(value).length - 1 : 0;
function generate(format, old) {
  for (;;) {
    const value = format === 'hex' ? hex() : base64url();
    // Leading letter keeps the value a safe YAML plain scalar (browser-session secret).
    if (value !== old && (format === 'hex' || /^[A-Za-z]/.test(value))) return value;
  }
}

function connects(options) {
  return new Promise(resolve => {
    const socket = net.connect(options);
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}
export async function activeEndpoints(base) {
  const active = [];
  for (const relative of SOCKETS) if (fs.existsSync(path.join(base, relative)) && await connects({ path: path.join(base, relative) })) active.push(relative);
  for (const port of PORTS) if (await connects({ host: '127.0.0.1', port })) active.push('127.0.0.1:' + port);
  return active;
}

/** Build the full in-memory plan; throws (writing nothing) on any inconsistency. */
export function planRotation(base) {
  const abs = relative => path.join(base, relative);
  const files = new Map(); // relative -> { before, after }
  const olds = [];         // { label, value } for every old secret/hash; must vanish from SCAN_DIRS
  const remember = (label, value) => olds.push({ label, value });
  const rotated = [], skipped = [], warnings = [];
  const text = relative => {
    if (!files.has(relative)) {
      const stat = fs.lstatSync(abs(relative));
      if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_FILE ' + relative);
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('FOREIGN_OWNER ' + relative);
      const before = fs.readFileSync(abs(relative), 'utf8');
      files.set(relative, { before, after: before });
    }
    return files.get(relative);
  };
  const exists = relative => fs.existsSync(abs(relative));
  const json = relative => JSON.parse(text(relative).after);
  // Replace exactly `expected` occurrences of old with next in one file's pending text.
  function substitute(relative, old, next, expected, verify) {
    const entry = text(relative);
    if (verify && !verify(JSON.parse(entry.after), old)) fail('CONSUMER_MISMATCH ' + relative);
    if (count(entry.after, old) !== expected) fail('UNEXPECTED_OCCURRENCES ' + relative);
    entry.after = entry.after.split(old).join(next);
    if (verify && !verify(JSON.parse(entry.after), next)) fail('CONSUMER_UPDATE_FAILED ' + relative);
  }
  function tokenFile(item, relative) {
    const old = text(relative).before.trim();
    const valid = item.format === 'hex' ? /^[a-f0-9]{64}$/ : /^[A-Za-z0-9_-]{32,256}$/;
    if (!valid.test(old)) fail('TOKEN_FORMAT ' + relative);
    const next = generate(item.format, old), oldHash = sha256(old), newHash = sha256(next);
    remember(relative, old); remember(relative + ' hash', oldHash);
    files.get(relative).after = next + '\n';
    for (const consumer of item.hashes) {
      if (!exists(consumer.file)) { skipped.push(consumer.file + ' ' + consumer.field + ' (absent)'); continue; }
      substitute(consumer.file, oldHash, newHash, count(text(consumer.file).after, oldHash) || 1, consumer.check);
    }
    rotated.push(relative);
    return { old, next };
  }

  if (!exists('operator/authority.json')) fail('AUTHORITY_CONFIG_MISSING');
  for (const item of INVENTORY) {
    if (item.file) {
      if (!exists(item.file)) { if (!item.optional) fail('TOKEN_MISSING ' + item.file); skipped.push(item.file + ' (absent)'); continue; }
      const { old, next } = tokenFile(item, item.file);
      if (item.file === 'qq-runtime/private/onebot.token') {
        const dir = 'qq-runtime/data/config';
        const configs = exists(dir) ? fs.readdirSync(abs(dir)).filter(name => /^onebot11.*\.json$/.test(name)).map(name => dir + '/' + name) : [];
        let updated = 0;
        for (const relative of configs) {
          const occurrences = count(text(relative).after, old);
          if (!occurrences) continue;
          const tokens = value => Object.values(value.network || {}).flat().filter(row => row && row.token !== undefined).map(row => row.token);
          substitute(relative, old, next, occurrences, (value, token) => tokens(value).filter(t => t === token).length === occurrences);
          updated++;
        }
        if (!updated) warnings.push('onebot token rotated but no NapCat onebot11*.json references it');
      }
    } else if (item.glob) {
      const dir = path.dirname(item.glob);
      const names = exists(dir) ? fs.readdirSync(abs(dir)).filter(name => name.endsWith('.token')).sort() : [];
      if (!names.length) skipped.push(item.glob + ' (absent)');
      for (const name of names) tokenFile(item, dir + '/' + name);
    } else if (item.env) {
      if (!exists(item.env)) { skipped.push(item.env + ' (absent)'); continue; }
      const entry = text(item.env), line = new RegExp('^' + item.key + '=(.*)$', 'm'), match = line.exec(entry.after);
      if (!match || !/^[a-f0-9]{64}$/.test(match[1].trim())) fail('ENV_TOKEN_FORMAT ' + item.env);
      const oldEnv = match[1].trim(), webui = 'qq-runtime/data/config/webui.json';
      const oldWebui = exists(webui) ? json(webui).token : undefined;
      if (oldWebui !== undefined && (typeof oldWebui !== 'string' || !oldWebui)) fail('WEBUI_TOKEN_FORMAT ' + webui);
      const next = generate('hex', oldEnv);
      if (next === oldWebui) fail('TOKEN_COLLISION');
      remember(item.env + ' ' + item.key, oldEnv);
      if (count(entry.after, oldEnv) !== 1) fail('UNEXPECTED_OCCURRENCES ' + item.env);
      entry.after = entry.after.replace(line, item.key + '=' + next);
      if (oldWebui !== undefined) {
        // Normally identical to the env value (one secret, two copies); only a WebUI-changed token is a second secret.
        if (oldWebui !== oldEnv) remember(webui + ' token', oldWebui);
        substitute(webui, oldWebui, next, 1, (value, token) => value.token === token);
      } else warnings.push('webui.json absent; only WEBUI_TOKEN env rotated');
      rotated.push(item.env + ' ' + item.key);
    } else if (item.yaml) {
      if (!exists(item.yaml)) { skipped.push(item.yaml + ' (absent)'); continue; }
      const entry = text(item.yaml), lines = entry.after.split('\n');
      // Block layout rendered by dsh-credentials-local (yaml Document.toString):
      // records: / <i>client-connection/browser-session: / kind: grant / payload: / version: 1 / secret: X
      const start = lines.findIndex(row => /^\s+client-connection\/browser-session:\s*$/.test(row));
      const indent = start < 0 ? -1 : /^\s*/.exec(lines[start])[0].length;
      let end = start + 1;
      while (start >= 0 && end < lines.length && (lines[end].trim() === '' || /^\s*/.exec(lines[end])[0].length > indent)) end++;
      const block = start < 0 ? [] : lines.slice(start + 1, end);
      const secretRows = block.map((row, index) => [index, /^(\s+secret:\s*)(['"]?)([A-Za-z0-9_-]{43})\2(\s*)$/.exec(row)]).filter(([, match]) => match);
      const recognized = start >= 0 && block.some(row => /^\s+kind:\s*grant\s*$/.test(row)) && block.some(row => /^\s+version:\s*1\s*$/.test(row)) && secretRows.length === 1 && count(entry.after, secretRows[0][1][3]) === 1;
      if (!recognized) {
        files.delete(item.yaml);
        warnings.push(item.yaml + ' browser-session record absent or unrecognized; left unchanged');
        continue;
      }
      const [index, match] = secretRows[0], old = match[3], next = generate('base64url', old);
      lines[start + 1 + index] = match[1] + match[2] + next + match[2] + match[4];
      entry.after = lines.join('\n');
      remember(item.yaml + ' ' + item.record, old);
      rotated.push(item.yaml + ' ' + item.record);
    }
  }

  // Every authority credential must belong to a rotated token; otherwise an old,
  // possibly exposed credential would stay valid.
  const authority = json('operator/authority.json');
  const newHashes = new Set([...files.entries()].filter(([relative]) => relative.endsWith('.token')).map(([, entry]) => sha256(entry.after.trim())));
  for (const row of authority.credentials || []) if (!newHashes.has(row.hash)) fail('UNMANAGED_CREDENTIAL role=' + row.role + (row.capabilityId ? ' capabilityId=' + row.capabilityId : '') + (row.entityId ? ' entityId=' + row.entityId : ''));
  if (!newHashes.has(authority.operator?.tokenHash)) fail('UNMANAGED_OPERATOR_HASH');
  const firstLabel = new Map();
  for (const { label, value } of olds) {
    if (firstLabel.has(value)) fail('DUPLICATE_SECRET ' + firstLabel.get(value) + ' ' + label);
    firstLabel.set(value, label);
  }

  // Residual scan: no old value may remain in any scanned config after the plan.
  const known = new Set(INVENTORY.flatMap(item => [item.file, item.env, item.yaml]).filter(Boolean));
  for (const dir of SCAN_DIRS) {
    if (!exists(dir) || !fs.statSync(abs(dir)).isDirectory()) continue;
    for (const name of fs.readdirSync(abs(dir))) {
      const relative = dir + '/' + name, stat = fs.lstatSync(abs(relative));
      if (!stat.isFile() || stat.size > 1048576) continue;
      if (name.endsWith('.token') && !known.has(relative) && !files.has(relative)) warnings.push('unmanaged token file ' + relative + ' (not rotated)');
      const content = files.has(relative) ? files.get(relative).after : fs.readFileSync(abs(relative), 'utf8');
      if (olds.some(({ value }) => content.includes(value))) fail('OLD_VALUE_REMAINS ' + relative);
    }
  }
  const changes = [...files.entries()].filter(([, entry]) => entry.after !== entry.before).map(([relative, entry]) => ({ relative, after: entry.after }));
  return { changes, rotated, skipped, warnings };
}

function atomicWrite(file, contents) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.rotate-' + process.pid + '.tmp');
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export async function rotateTokens({ base, dryRun = false, now = new Date(), probe = activeEndpoints } = {}) {
  process.umask(0o077);
  if (!base || !path.isAbsolute(base) || path.basename(base) !== 'companion-world-v1') fail('BASE_INVALID');
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) fail('BASE_MISSING');
  const active = await probe(base);
  if (active.length) fail('SERVICES_ACTIVE ' + active.join(','));
  const { changes, rotated, skipped, warnings } = planRotation(base);
  const summary = { dryRun, base, rotated, changedFiles: changes.map(change => change.relative), skipped, warnings };
  if (dryRun) return { ...summary, backup: null };
  const backup = path.join(base, 'rotation-backup-' + now.toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, { mode: 0o700 });
  for (const { relative } of changes) {
    const target = path.join(backup, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(base, relative), target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
  try { for (const { relative, after } of changes) atomicWrite(path.join(base, relative), after); }
  catch { fail('WRITE_FAILED restore from ' + backup); }
  return { ...summary, backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    let base = path.join(os.homedir(), '.local/share/companion-world-v1'), dryRun = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--dry-run') dryRun = true;
      else if (args[index] === '--base' && args[index + 1]) base = path.resolve(args[++index]);
      else fail('USAGE rotate-tokens.mjs [--base DIR] [--dry-run]');
    }
    process.stdout.write(JSON.stringify(await rotateTokens({ base, dryRun }), null, 2) + '\n');
  } catch (error) {
    // Only our own codes (file names, never values) are printed; JSON.parse messages may quote content.
    process.stderr.write('Token rotation refused: ' + (error?.rotation ? error.message : (error?.code || 'UNEXPECTED_ERROR')) + '\nNothing was written unless the message names a backup; keep services stopped.\n');
    process.exitCode = 1;
  }
}
