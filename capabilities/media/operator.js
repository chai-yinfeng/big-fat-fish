import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLocalSpeechRunner } from '../speech/runner.js';
import { loadSpeechConfig, trustedReference, wavInfo, VOICE_ID, USAGE_SCOPES } from '../speech/config.js';

const MAX_AUDIO = 2 * 1024 * 1024;
const PUBLIC_TEST_TEXT = '你好，这是一次本地语音试听。今天也辛苦了，我们慢慢聊吧。';
// Only one TTS adapter exists; a new upload is registered against it.
const DEFAULT_ENGINE = 'llama-tts';
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const closed = (input, keys, required = keys) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(input, k))) throw fail('CONTENT_OPERATOR_INPUT');
};
const shortText = (value, max) => typeof value === 'string' && value.trim() !== '' && [...value].length <= max && !value.includes('\0');

/** Host-only operation port. No model tool, Authority writer or platform action.
 * speechFactory is only a dependency-injection seam, never a JSON config field. */
export function createContentOperator({ speechConfigFile, worldStatus, speechFactory = options => createLocalSpeechRunner(options), unlinkReference = file => fs.unlinkSync(file) }) {
  if (!path.isAbsolute(speechConfigFile) || typeof worldStatus !== 'function') throw fail('CONTENT_OPERATOR_CONFIG', 503);
  const runner = speechFactory({ configFile: speechConfigFile });
  let busy = false;
  function read() {
    try {
      if (!fs.lstatSync(speechConfigFile).isFile() || fs.lstatSync(speechConfigFile).isSymbolicLink()) throw 0;
      const bytes = fs.readFileSync(speechConfigFile), config = loadSpeechConfig(speechConfigFile);
      if (!fs.readFileSync(speechConfigFile).equals(bytes)) throw 0;
      return { config, revision: digest(bytes) };
    } catch { throw fail('CONTENT_OPERATOR_UNAVAILABLE', 503); }
  }
  function projected({ config, revision }) {
    const s = runner.status(), models = {};
    for (const [key, value] of Object.entries(s.models || {})) {
      if (/^(?:asr:(?:default|fast)|tts:[a-z0-9-]{1,40})$/.test(key) && value) models[key] = { model: typeof value.model === 'string' ? value.model : '', componentsPresent: value.componentsPresent === true, enabled: value.enabled === true, verified: value.verified === true };
    }
    // Never project paths, transcripts or upload IDs.
    const profiles = Object.values(config.voiceProfiles).map(p => {
      let hasReference = false; try { trustedReference(config, p); hasReference = true; } catch {}
      return { id: p.id, label: p.label, engine: p.engine, referenceLanguage: p.referenceLanguage, usageScope: p.usageScope, useReferenceText: p.useReferenceText, auditioned: p.auditioned === true, hasReference };
    });
    return { speech: { configurationRevision: revision, numThreads: config.numThreads, maxTextChars: config.maxTextChars, models }, voices: { defaultVoice: config.defaultVoice, profiles, cleanupPending: config.pendingReferenceCleanup !== undefined, referenceConditioning: 'speaker-file-only', transcriptUsedForSynthesis: false }, imageGeneration: { configured: false, status: 'not_configured' } };
  }
  async function paused(input, signal) {
    if (signal?.aborted) throw fail('CONTENT_OPERATOR_CANCELLED', 409);
    const world = await worldStatus();
    // worldRevision is optional; when given, the world must not have changed since.
    if (!world.paused || (input.worldRevision !== undefined && (!Number.isSafeInteger(input.worldRevision) || world.revision !== input.worldRevision))) throw fail('CONTENT_OPERATOR_WORLD_CONFLICT', 409);
  }
  function cas(expectedRevision) {
    const current = read();
    if (typeof expectedRevision !== 'string' || current.revision !== expectedRevision) throw fail('CONTENT_OPERATOR_REVISION_CONFLICT', 409);
    return current;
  }
  async function commit(config, input, signal) {
    await paused(input, signal); cas(input.expectedRevision);
    const parent = fs.realpathSync(path.dirname(speechConfigFile));
    if (fs.realpathSync(speechConfigFile) !== path.join(parent, path.basename(speechConfigFile))) throw fail('CONTENT_OPERATOR_CONFIG', 503);
    const temporary = path.join(parent, '.speech-operator-' + randomUUID() + '.json');
    try {
      fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      // Both absolute targets were verified as this config and its own new
      // sibling. The trusted file replacement never accepts a caller path.
      fs.renameSync(temporary, speechConfigFile);
    } finally {
      if (fs.existsSync(temporary)) { if (path.dirname(temporary) !== parent || fs.lstatSync(temporary).isSymbolicLink()) throw fail('CONTENT_OPERATOR_CONFIG', 503); fs.unlinkSync(temporary); }
    }
  }
  function referenceDirectory(config) {
    const root = fs.realpathSync(config.workRoot), target = path.join(root, 'reference');
    fs.mkdirSync(target, { mode: 0o700, recursive: true });
    if (fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503);
    return target;
  }
  function ownedReference(config, file, allowMissing = false) {
    const root = referenceDirectory(config);
    if (!path.isAbsolute(file) || path.dirname(file) !== root || !/^operator-[a-f0-9-]{36}\.wav$/.test(path.basename(file))) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503);
    const targets = [file, file + '.json'];
    for (const target of targets) {
      let stat; try { stat = fs.lstatSync(target); } catch (error) { if (allowMissing && error.code === 'ENOENT') continue; throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503); }
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503);
    }
    return targets;
  }
  function voiceOf(config, voiceId) {
    if (typeof voiceId !== 'string' || !VOICE_ID.test(voiceId)) throw fail('CONTENT_OPERATOR_INPUT');
    if (!Object.hasOwn(config.voiceProfiles, voiceId)) throw fail('CONTENT_OPERATOR_VOICE_MISSING', 409);
    return config.voiceProfiles[voiceId];
  }
  function ttsReady(engine) {
    const model = runner.status().models?.['tts:' + engine];
    if (!model?.componentsPresent || !model.enabled) throw fail('CONTENT_OPERATOR_MODEL_UNAVAILABLE', 503);
  }
  async function call(input, { signal } = {}) {
    if (input?.action === 'status') { closed(input, ['action', 'worldRevision'], ['action']); return projected(read()); }
    if (busy) throw fail('CONTENT_OPERATOR_BUSY', 409);
    busy = true;
    try {
      await paused(input || {}, signal);
      if (input.action === 'configure') {
        closed(input, ['action', 'expectedRevision', 'numThreads', 'maxTextChars', 'worldRevision'], ['action', 'expectedRevision', 'numThreads', 'maxTextChars']);
        const { config } = cas(input.expectedRevision);
        if (!Number.isInteger(input.numThreads) || input.numThreads < 1 || input.numThreads > 16 || !Number.isInteger(input.maxTextChars) || input.maxTextChars < 1 || input.maxTextChars > 120) throw fail('CONTENT_OPERATOR_INPUT');
        Object.assign(config, { numThreads: input.numThreads, maxTextChars: input.maxTextChars });
        await commit(config, input, signal); return projected(read());
      }
      if (input.action === 'setDefaultVoice') {
        closed(input, ['action', 'expectedRevision', 'voiceId', 'worldRevision'], ['action', 'expectedRevision', 'voiceId']);
        const { config } = cas(input.expectedRevision);
        voiceOf(config, input.voiceId);
        config.defaultVoice = input.voiceId;
        await commit(config, input, signal); return projected(read());
      }
      if (input.action === 'reference') {
        closed(input, ['action', 'expectedRevision', 'voiceId', 'label', 'language', 'usageScope', 'audioBase64', 'transcript', 'authorized', 'worldRevision'], ['action', 'expectedRevision', 'voiceId', 'label', 'language', 'usageScope', 'audioBase64', 'transcript', 'authorized']);
        const { config } = cas(input.expectedRevision);
        if (config.pendingReferenceCleanup !== undefined) throw fail('CONTENT_OPERATOR_REFERENCE_CLEANUP_PENDING', 409);
        if (typeof input.voiceId !== 'string' || !VOICE_ID.test(input.voiceId) || !shortText(input.label, 64) || typeof input.language !== 'string' || !/^[a-z]{2,3}$/.test(input.language) || !USAGE_SCOPES.includes(input.usageScope)) throw fail('CONTENT_OPERATOR_INPUT');
        if (Object.hasOwn(config.voiceProfiles, input.voiceId)) throw fail('CONTENT_OPERATOR_VOICE_EXISTS', 409);
        if (input.authorized !== true || !shortText(input.transcript, 1000) || typeof input.audioBase64 !== 'string') throw fail('CONTENT_OPERATOR_INPUT');
        if (input.audioBase64.length > Math.ceil(MAX_AUDIO / 3) * 4) throw fail('CONTENT_OPERATOR_AUDIO_LIMIT', 413);
        const data = Buffer.from(input.audioBase64, 'base64');
        if (!data.length || data.toString('base64') !== input.audioBase64) throw fail('CONTENT_OPERATOR_AUDIO_INVALID');
        if (data.length > MAX_AUDIO) throw fail('CONTENT_OPERATOR_AUDIO_LIMIT', 413);
        if (!Object.hasOwn(config.models.tts, DEFAULT_ENGINE)) throw fail('CONTENT_OPERATOR_MODEL_UNAVAILABLE', 503);
        const referenceRoot = referenceDirectory(config), file = path.join(referenceRoot, 'operator-' + randomUUID() + '.wav');
        let audioWritten = false, manifestWritten = false, committed = false;
        try {
          await paused(input, signal); cas(input.expectedRevision);
          fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' }); audioWritten = true;
          let info; try { info = wavInfo(file, MAX_AUDIO); } catch { throw fail('CONTENT_OPERATOR_AUDIO_INVALID'); }
          if (info.format !== 1 || info.bits !== 16 || info.durationMs < 3000 || info.durationMs > 20000) throw fail('CONTENT_OPERATOR_AUDIO_INVALID');
          const manifest = { schemaVersion: 1, origin: 'operator-authorized', voiceId: input.voiceId, sha256: digest(data), transcript: input.transcript, consentRecordedAt: new Date().toISOString() };
          fs.writeFileSync(file + '.json', JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 }); manifestWritten = true;
          // The transcript is provenance only: llama-tts conditions on speaker audio.
          config.voiceProfiles[input.voiceId] = { id: input.voiceId, label: input.label, engine: DEFAULT_ENGINE, referencePath: file, referenceTranscript: input.transcript, referenceLanguage: input.language, useReferenceText: false, usageScope: input.usageScope, auditioned: false };
          if (config.defaultVoice === null) config.defaultVoice = input.voiceId;
          await commit(config, input, signal); committed = true;
          return projected(read());
        } finally {
          if (!committed) for (const [target, written] of [[file, audioWritten], [file + '.json', manifestWritten]]) if (written && fs.existsSync(target)) {
            if (path.dirname(target) !== referenceRoot || fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503); fs.unlinkSync(target);
          }
        }
      }
      if (input.action === 'removeReference') {
        // voiceId is required to start a removal; a retry of a pending cleanup may omit it.
        closed(input, ['action', 'expectedRevision', 'voiceId', 'confirmed', 'worldRevision'], ['action', 'expectedRevision', 'confirmed']);
        if (input.confirmed !== true) throw fail('CONTENT_OPERATOR_CONFIRMATION_REQUIRED');
        let current = cas(input.expectedRevision);
        if (current.config.pendingReferenceCleanup === undefined) {
          const p = voiceOf(current.config, input.voiceId);
          ownedReference(current.config, p.referencePath);
          const next = structuredClone(current.config);
          delete next.voiceProfiles[p.id];
          // Removing the default leaves no default; the operator picks a new one explicitly.
          if (next.defaultVoice === p.id) next.defaultVoice = null;
          // Keep only our generated upload ID, not a caller-selected deletion
          // path. A failed unlink remains visible and retryable after restart.
          next.pendingReferenceCleanup = { uploadId: path.basename(p.referencePath).slice('operator-'.length, -'.wav'.length) };
          await commit(next, input, signal);
          current = read();
        } else if (input.voiceId !== undefined && Object.hasOwn(current.config.voiceProfiles, input.voiceId)) throw fail('CONTENT_OPERATOR_REFERENCE_CLEANUP_PENDING', 409);
        const file = path.join(referenceDirectory(current.config), 'operator-' + current.config.pendingReferenceCleanup.uploadId + '.wav'), targets = ownedReference(current.config, file, true);
        await paused(input, signal); cas(current.revision);
        // All absolute targets have been verified before deletion. Already
        // missing files are success on retry; any other failure keeps pending.
        for (const target of targets) {
          let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503);
          unlinkReference(target);
        }
        const completed = cas(current.revision).config;
        delete completed.pendingReferenceCleanup;
        await commit(completed, { ...input, expectedRevision: current.revision }, signal);
        return projected(read());
      }
      if (input.action === 'test') {
        closed(input, ['action', 'voiceId', 'worldRevision'], ['action', 'voiceId']);
        const { config } = read(), p = voiceOf(config, input.voiceId);
        ttsReady(p.engine);
        trustedReference(config, p);
        const root = fs.realpathSync(config.workRoot), file = path.join(root, 'tts-' + randomUUID() + '.wav');
        try {
          const result = await runner.synthesize({ text: PUBLIC_TEST_TEXT, outputFile: file, voiceProfile: p.id, signal });
          await paused(input, signal);
          if (path.dirname(file) !== root || fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()) throw fail('CONTENT_OPERATOR_AUDIO_INVALID', 503);
          const info = wavInfo(file, 5 * 1024 * 1024), data = fs.readFileSync(file);
          return { audioBase64: data.toString('base64'), mime: 'audio/wav', durationMs: info.durationMs, model: result.model, voiceId: p.id, referenceConditioning: 'speaker-file-only', transcriptUsedForSynthesis: false };
        } finally {
          if (fs.existsSync(file)) { if (path.dirname(file) !== root || fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503); fs.unlinkSync(file); }
        }
      }
      throw fail('CONTENT_OPERATOR_ACTION');
    } catch (error) {
      if (/^CONTENT_OPERATOR_[A-Z_]+$/.test(error?.code || '')) throw error;
      throw fail('CONTENT_OPERATOR_UNAVAILABLE', 503);
    } finally { busy = false; }
  }
  return { call };
}
