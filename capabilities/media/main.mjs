#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AuthorityClient } from '../../authority/src/client.js';
import { createLocalSpeechRunner } from '../speech/runner.js';
import { ArtifactStore } from './artifacts.js';
import { MediaService } from './service.js';
import { createContentServer } from './server.mjs';
import { capabilityGateway } from './client.js';
import { createContentOperator } from './operator.js';

process.umask(0o077);
let server, timer;
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config' || !path.isAbsolute(process.argv[3])) throw Error('CONFIG');
  const file = process.argv[3], stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0) throw Error('CONFIG');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Object.keys(cfg).some(k => !['store', 'workRoot', 'speechConfigFile', 'authority', 'gateway', 'sharpModule', 'control'].includes(k)) || !path.isAbsolute(cfg.sharpModule)) throw Error('CONFIG');
  const store = new ArtifactStore(cfg.store), speech = createLocalSpeechRunner({ configFile: cfg.speechConfigFile });
  const authority = new AuthorityClient(cfg.authority), gateway = capabilityGateway(cfg.gateway);
  let sharp;
  const normalizeImage = async data => {
    sharp ||= createRequire(import.meta.url)(cfg.sharpModule);
    const image = await sharp(data, { limitInputPixels: 40000000, animated: false, page: 0, pages: 1 }).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
    return { data: image, mime: 'image/jpeg' };
  };
  const speechDefaults = () => ({ maxAudioSeconds: JSON.parse(fs.readFileSync(cfg.speechConfigFile, 'utf8')).maxAudioSeconds || 30 });
  const service = new MediaService({ store, speech, ...gateway, normalizeImage, workRoot: cfg.workRoot, speechDefaults });
  const worldStatus = async () => (await authority.health()).world;
  const operator = createContentOperator({ speechConfigFile: cfg.speechConfigFile, worldStatus, speechFactory: () => speech });
  server = createContentServer({ ...cfg.control, service, worldStatus, operatorCall: (input, options) => operator.call(input, options) });
  await server.start();
  store.expire(); timer = setInterval(() => { try { store.expire(); } catch { process.stderr.write('Media retention requires operator inspection.\n'); } }, 3600000);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; clearInterval(timer); await server.close(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(); });
  process.stdout.write('Companion content service ready; file speech has no audio-device dependency.\n');
} catch {
  clearInterval(timer); if (server) await server.close().catch(() => {});
  process.stderr.write('Companion content service could not start; inspect private configuration and runtime components.\n');
  process.exitCode = 1;
}
