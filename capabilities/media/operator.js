import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createLocalSpeechRunner } from '../speech/runner.js';
import { loadSpeechConfig, trustedReference, wavInfo } from '../speech/config.js';

const MAX_AUDIO = 2 * 1024 * 1024;
const PUBLIC_TEST_TEXT = '你好，这是一次本地语音试听。今天也辛苦了，我们慢慢聊吧。';
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const closed = (input, keys, required = keys) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(input, k))) throw fail('CONTENT_OPERATOR_INPUT');
};

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
    for (const kind of ['asr', 'tts']) for (const quality of ['light', 'heavy']) {
      const key = kind + ':' + quality, value = s.models?.[key];
      if (value) models[key] = { model: typeof value.model === 'string' ? value.model : '', componentsPresent: value.componentsPresent === true, enabled: value.enabled === true, verified: value.verified === true };
    }
    let hasReference = false; try { trustedReference(config); hasReference = true; } catch {}
    return { speech: { configurationRevision: revision, defaultTtsQuality: config.defaultTtsQuality === 'light' ? 'light' : 'heavy', numThreads: config.numThreads, maxTextChars: config.maxTextChars, models }, voice: { profileId: 'default', origin: config.voiceProfiles.default.referenceOrigin === 'operator-authorized' ? 'operator-authorized' : 'kokoro-local', hasReference, cleanupPending: config.voiceProfiles.default.pendingReferenceCleanup !== undefined, referenceConditioning: 'speaker-file-only', transcriptUsedForSynthesis: false }, imageGeneration: { configured: false, status: 'not_configured' } };
  }
  async function paused(input, signal) {
    if (signal?.aborted) throw fail('CONTENT_OPERATOR_CANCELLED', 409);
    const world = await worldStatus();
    if (!world.paused || !Number.isSafeInteger(input.worldRevision) || world.revision !== input.worldRevision) throw fail('CONTENT_OPERATOR_WORLD_CONFLICT', 409);
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
  function ownedReference(config, file = config.voiceProfiles.default.referencePath, allowMissing = false) {
    const root = referenceDirectory(config);
    if (!path.isAbsolute(file) || path.dirname(file) !== root || !/^operator-[a-f0-9-]{36}\.wav$/.test(path.basename(file))) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503);
    const targets = [file, file + '.json'];
    for (const target of targets) {
      let stat; try { stat = fs.lstatSync(target); } catch (error) { if (allowMissing && error.code === 'ENOENT') continue; throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503); }
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503);
    }
    return targets;
  }
  function pendingReference(config) {
    const pending = config.voiceProfiles.default.pendingReferenceCleanup;
    if (!pending || typeof pending.uploadId !== 'string' || !/^[a-f0-9-]{36}$/.test(pending.uploadId) || Object.keys(pending).some(k => k !== 'uploadId')) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503);
    return path.join(referenceDirectory(config), 'operator-' + pending.uploadId + '.wav');
  }
  async function call(input, { signal } = {}) {
    if (input?.action === 'status') { closed(input, ['action', 'worldRevision'], ['action']); return projected(read()); }
    if (busy) throw fail('CONTENT_OPERATOR_BUSY', 409);
    busy = true;
    try {
      await paused(input || {}, signal);
      if (input.action === 'configure') {
        closed(input, ['action', 'expectedRevision', 'defaultTtsQuality', 'numThreads', 'maxTextChars', 'worldRevision']);
        const { config } = cas(input.expectedRevision);
        if (!['light', 'heavy'].includes(input.defaultTtsQuality) || ![1, 2].includes(input.numThreads) || !Number.isInteger(input.maxTextChars) || input.maxTextChars < 1 || input.maxTextChars > 120) throw fail('CONTENT_OPERATOR_INPUT');
        if (input.defaultTtsQuality === 'heavy') {
          const model = runner.status().models?.['tts:heavy'];
          if (!model?.componentsPresent || !model.enabled || !model.verified) throw fail('CONTENT_OPERATOR_MODEL_UNAVAILABLE', 503);
        }
        Object.assign(config, { defaultTtsQuality: input.defaultTtsQuality, numThreads: input.numThreads, maxTextChars: input.maxTextChars });
        await commit(config, input, signal); return projected(read());
      }
      if (input.action === 'reference') {
        closed(input, ['action', 'expectedRevision', 'audioBase64', 'transcript', 'authorized', 'worldRevision']);
        const { config } = cas(input.expectedRevision), p = config.voiceProfiles.default;
        if (p.pendingReferenceCleanup !== undefined) throw fail('CONTENT_OPERATOR_REFERENCE_CLEANUP_PENDING', 409);
        if (p.referenceOrigin === 'operator-authorized') throw fail('CONTENT_OPERATOR_REFERENCE_EXISTS', 409);
        if (input.authorized !== true || typeof input.transcript !== 'string' || !input.transcript.trim() || [...input.transcript].length > 1000 || input.transcript.includes('\0') || typeof input.audioBase64 !== 'string') throw fail('CONTENT_OPERATOR_INPUT');
        if (input.audioBase64.length > Math.ceil(MAX_AUDIO / 3) * 4) throw fail('CONTENT_OPERATOR_AUDIO_LIMIT', 413);
        const data = Buffer.from(input.audioBase64, 'base64');
        if (!data.length || data.toString('base64') !== input.audioBase64) throw fail('CONTENT_OPERATOR_AUDIO_INVALID');
        if (data.length > MAX_AUDIO) throw fail('CONTENT_OPERATOR_AUDIO_LIMIT', 413);
        // Validate and preserve the synthetic pointer before accepting a new
        // recording. Never turn an arbitrary path into a removable reference.
        if (p.referenceOrigin !== 'kokoro-local') throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503);
        trustedReference(config);
        const referenceRoot = referenceDirectory(config), file = path.join(referenceRoot, 'operator-' + randomUUID() + '.wav');
        let audioWritten = false, manifestWritten = false, committed = false;
        try {
          await paused(input, signal); cas(input.expectedRevision);
          fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' }); audioWritten = true;
          let info; try { info = wavInfo(file, MAX_AUDIO); } catch { throw fail('CONTENT_OPERATOR_AUDIO_INVALID'); }
          if (info.format !== 1 || info.bits !== 16 || info.durationMs < 3000 || info.durationMs > 20000) throw fail('CONTENT_OPERATOR_AUDIO_INVALID');
          const manifest = { schemaVersion: 1, origin: 'operator-authorized', sha256: digest(data), transcript: input.transcript, consentRecordedAt: new Date().toISOString() };
          fs.writeFileSync(file + '.json', JSON.stringify(manifest) + '\n', { flag: 'wx', mode: 0o600 }); manifestWritten = true;
          p.syntheticReference = { referencePath: p.referencePath, referenceOrigin: 'kokoro-local', speakerId: p.speakerId };
          p.referencePath = file; p.referenceOrigin = 'operator-authorized'; p.auditioned = false;
          await commit(config, input, signal); committed = true;
          return projected(read());
        } finally {
          if (!committed) for (const [target, written] of [[file, audioWritten], [file + '.json', manifestWritten]]) if (written && fs.existsSync(target)) {
            if (path.dirname(target) !== referenceRoot || fs.lstatSync(target).isSymbolicLink() || fs.realpathSync(target) !== target) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503); fs.unlinkSync(target);
          }
        }
      }
      if (input.action === 'removeReference') {
        closed(input, ['action', 'expectedRevision', 'confirmed', 'worldRevision']);
        if (input.confirmed !== true) throw fail('CONTENT_OPERATOR_CONFIRMATION_REQUIRED');
        let current = cas(input.expectedRevision);
        const p = current.config.voiceProfiles.default;
        if (p.pendingReferenceCleanup === undefined) {
          if (p.referenceOrigin !== 'operator-authorized') throw fail('CONTENT_OPERATOR_REFERENCE_MISSING', 409);
          ownedReference(current.config);
          const restore = p.syntheticReference;
          if (!restore || restore.referenceOrigin !== 'kokoro-local') throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503);
          const restored = structuredClone(current.config), profile = restored.voiceProfiles.default;
          Object.assign(profile, restore); delete profile.syntheticReference; profile.auditioned = false;
          // Keep only our generated upload ID, not a caller-selected deletion
          // path. A failed unlink remains visible and retryable after restart.
          profile.pendingReferenceCleanup = { uploadId: path.basename(p.referencePath).slice('operator-'.length, -'.wav'.length) };
          trustedReference(restored);
          await commit(restored, input, signal);
          current = read();
        }
        const file = pendingReference(current.config), targets = ownedReference(current.config, file, true);
        await paused(input, signal); cas(current.revision);
        // All absolute targets have been verified before deletion. Already
        // missing files are success on retry; any other failure keeps pending.
        for (const target of targets) {
          let stat; try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) throw fail('CONTENT_OPERATOR_REFERENCE_PATH', 503);
          unlinkReference(target);
        }
        const completed = cas(current.revision).config;
        delete completed.voiceProfiles.default.pendingReferenceCleanup;
        await commit(completed, { ...input, expectedRevision: current.revision }, signal);
        return projected(read());
      }
      if (input.action === 'test') {
        closed(input, ['action', 'quality', 'worldRevision']);
        if (input.quality !== 'heavy') throw fail('CONTENT_OPERATOR_INPUT');
        const { config } = read(), model = runner.status().models?.['tts:heavy'];
        if (!model?.componentsPresent || !model.enabled || !model.verified) throw fail('CONTENT_OPERATOR_MODEL_UNAVAILABLE', 503);
        trustedReference(config);
        const root = fs.realpathSync(config.workRoot), file = path.join(root, 'tts-' + randomUUID() + '.wav');
        try {
          const result = await runner.synthesize({ text: PUBLIC_TEST_TEXT, quality: 'heavy', outputFile: file, voiceProfile: 'default', signal });
          await paused(input, signal);
          if (path.dirname(file) !== root || fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()) throw fail('CONTENT_OPERATOR_AUDIO_INVALID', 503);
          const info = wavInfo(file, 5 * 1024 * 1024), data = fs.readFileSync(file);
          return { audioBase64: data.toString('base64'), mime: 'audio/wav', durationMs: info.durationMs, model: result.model, referenceConditioning: 'speaker-file-only', transcriptUsedForSynthesis: false };
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
