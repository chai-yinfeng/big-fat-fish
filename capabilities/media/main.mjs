#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AuthorityClient } from '../../authority/src/client.js';
import { createLocalSpeechRunner } from '../speech/runner.js';
import { ArtifactStore } from './artifacts.js';
import { MediaService } from './service.js';
import { createContentServer } from './server.mjs';
import { capabilityGateway, meteredSpeech } from './client.js';
import { createContentOperator } from './operator.js';
import { createJobs } from './jobs.js';
import { createDemoRunner } from './demo-job.js';

process.umask(0o077);
let server, timer, jobs;
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--config' || !path.isAbsolute(process.argv[3])) throw Error('CONFIG');
  const file = process.argv[3], stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) !== 0) throw Error('CONFIG');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Object.keys(cfg).some(k => !['store', 'workRoot', 'speechConfigFile', 'authority', 'gateway', 'sharpModule', 'control'].includes(k)) || !path.isAbsolute(cfg.sharpModule)) throw Error('CONFIG');
  const authority = new AuthorityClient(cfg.authority), gateway = capabilityGateway(cfg.gateway);
  // Conversation speech and the operator's voice test share this runner, so both are counted.
  const store = new ArtifactStore(cfg.store), speech = meteredSpeech(createLocalSpeechRunner({ configFile: cfg.speechConfigFile }), gateway.recordUsage);
  let sharp;
  const normalizeImage = async data => {
    sharp ||= createRequire(import.meta.url)(cfg.sharpModule);
    const image = await sharp(data, { limitInputPixels: 40000000, animated: false, page: 0, pages: 1 }).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
    return { data: image, mime: 'image/jpeg' };
  };
  const worldStatus = async () => (await authority.health()).world;
  // Background jobs keep their records beside the media files (no new configuration key: the previous release
  // reads this same content.json and ignores the file).
  jobs = createJobs({ file: path.join(cfg.store.root, 'jobs.json'), runners: { demo: createDemoRunner() }, worldStatus, usage: { reserve: capability => gateway.reserveUsage({ capability }), record: gateway.recordUsage } });
  const media = new MediaService({ store, speech, ...gateway, normalizeImage, workRoot: cfg.workRoot, jobs });
  // Every request somebody is waiting for goes through the gate, so a yielding background job lets it go first.
  const service = { call: (scope, input) => jobs.gate.timely(() => media.call(scope, input)) };
  const operator = createContentOperator({ speechConfigFile: cfg.speechConfigFile, worldStatus, speechFactory: () => speech });
  server = createContentServer({ ...cfg.control, service, worldStatus, operatorCall: (input, options) => input?.action === 'test' ? jobs.gate.timely(() => operator.call(input, options)) : operator.call(input, options), jobsCall: input => jobs.control(input) });
  await server.start();
  jobs.start();
  store.expire(); timer = setInterval(() => { try { store.expire(); jobs.sweep(); } catch { process.stderr.write('Media retention requires operator inspection.\n'); } }, 3600000);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; clearInterval(timer); await jobs.close(); await server.close(); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(); });
  process.stdout.write('Companion content service ready; file speech has no audio-device dependency.\n');
} catch {
  clearInterval(timer); await jobs?.close().catch(() => {}); if (server) await server.close().catch(() => {});
  process.stderr.write('Companion content service could not start; inspect private configuration and runtime components.\n');
  process.exitCode = 1;
}
