#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSpeech } from './prepare-speech.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Release: ops/ sits next to capabilities/; checkout: deploy/authority/.
const tree = fs.existsSync(path.join(here, '../capabilities')) ? path.resolve(here, '..') : path.resolve(here, '../..');
// content.json's keys and defaults (capabilities/media/config.js).
const { defaults } = await import(pathToFileURL(path.join(tree, 'capabilities/media/config.js')).href);

// Adds product-owned media infrastructure only. Installation/download/inference
// remain explicit operator steps; this never touches QQ login volumes or memory.
export function prepareContent(base = path.join(os.homedir(), '.local/share/companion-world-v1'), runtime = path.join(os.homedir(), '.local/opt/companion/speech-node')) {
  if (!path.isAbsolute(base) || path.basename(base) !== 'companion-world-v1') throw Error('CONTENT_BASE');
  const authorityFile = path.join(base, 'operator/authority.json'), authority = JSON.parse(fs.readFileSync(authorityFile, 'utf8'));
  const layoutFile = path.join(base, 'operator/execution-storage.json');
  const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
  if (layout.version !== 2 || layout.sessionsRoot !== 'conversation-data/sessions') throw Error('CONTENT_STORAGE_LAYOUT');
  prepareSpeech(base, runtime);
  for (const directory of ['ipc/content', 'authority-content', 'media-data']) fs.mkdirSync(path.join(base, directory), { recursive: true, mode: 0o700 });
  const tokenFile = path.join(base, 'authority-content/control.token');
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  const configFile = path.join(base, 'operator/content.json');
  if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, JSON.stringify({
    store: { root: path.join(base, 'media-data'), ...defaults.store },
    workRoot: path.join(base, 'speech-data'), speechConfigFile: path.join(base, 'operator/speech.json'),
    authority: { socketPath: path.join(base, 'ipc/authority/authority.sock'), tokenFile: path.join(base, 'service-config/health.token') },
    gateway: { socketPath: path.join(base, 'ipc/model/inference.sock'), tokenFile: path.join(base, 'service-config/inference.token') },
    sharpModule: path.join(runtime, 'node_modules/sharp'),
    control: { socketPath: path.join(base, 'ipc/content/content.sock'), tokenFile },
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  authority.content = { socketPath: '/authority/content-ipc/content.sock', tokenFile: '/authority/content-config/control.token' };
  fs.writeFileSync(authorityFile, JSON.stringify(authority, null, 2) + '\n', { mode: 0o600 });
  const qqFile = path.join(base, 'operator/qq-bridge.json');
  if (fs.existsSync(qqFile)) { const qq = JSON.parse(fs.readFileSync(qqFile, 'utf8')); qq.contentEnabled = true; fs.writeFileSync(qqFile, JSON.stringify(qq, null, 2) + '\n', { mode: 0o600 }); }
  layout.media = { root: 'media-data', workRoot: 'speech-data' };
  fs.writeFileSync(layoutFile, JSON.stringify(layout) + '\n', { mode: 0o600 });
  return { prepared: true, modelsInstalled: false, cloudVoiceEnabled: false, replyMode: 'text-unless-requested', mediaCacheDays: defaults.store.ttlMs / 86400000 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { console.log(JSON.stringify(prepareContent())); }
  catch { console.error('Content preparation failed; inspect private infrastructure configuration.'); process.exitCode = 1; }
}
