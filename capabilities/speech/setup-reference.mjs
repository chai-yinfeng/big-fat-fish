#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createLocalSpeechRunner } from './runner.js';
import { loadSpeechConfig, REFERENCE_TEXT, failure } from './config.js';

/** Explicit operator setup: fixed public synthetic text, never an incoming person's audio. */
export async function setupSyntheticReference(configFile) {
  const c = loadSpeechConfig(configFile), p = c.voiceProfiles.default;
  if (p.referenceOrigin !== 'kokoro-local') throw failure('SPEECH_REFERENCE_REQUIRED');
  const manifestFile = p.referencePath + '.json';
  if (fs.existsSync(p.referencePath)) {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (m.origin !== 'kokoro-local' || m.text !== REFERENCE_TEXT || m.model !== c.models.tts.light.id || m.speakerId !== p.speakerId || m.sha256 !== createHash('sha256').update(fs.readFileSync(p.referencePath)).digest('hex')) throw failure('SPEECH_REFERENCE_REQUIRED');
    return { referencePrepared: true, preserved: true, origin: 'kokoro-local', voiceAuditioned: p.auditioned === true };
  }
  const value = await createLocalSpeechRunner({ configFile }).synthesize({ text: REFERENCE_TEXT, outputFile: p.referencePath, quality: 'light', voiceProfile: 'default' });
  const metadata = { schemaVersion: 1, origin: 'kokoro-local', model: value.model, text: REFERENCE_TEXT, speakerId: p.speakerId, sampleRate: value.sampleRate, durationMs: value.durationMs, sha256: createHash('sha256').update(fs.readFileSync(p.referencePath)).digest('hex') };
  fs.writeFileSync(manifestFile, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { referencePrepared: true, preserved: false, origin: 'kokoro-local', durationMs: value.durationMs, sampleRate: value.sampleRate, voiceAuditioned: p.auditioned === true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') throw failure('SPEECH_CONFIG');
    process.stdout.write(JSON.stringify(await setupSyntheticReference(process.argv[3])) + '\n');
  } catch (e) {
    process.stderr.write(['SPEECH_NOT_CONFIGURED', 'SPEECH_REFERENCE_REQUIRED'].includes(e.code) ? e.code + '\n' : 'SPEECH_SETUP_FAILED\n');
    process.exitCode = 1;
  }
}
