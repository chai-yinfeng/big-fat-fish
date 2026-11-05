#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createLocalSpeechRunner } from '../../capabilities/speech/runner.js';
import { setupSyntheticReference } from '../../capabilities/speech/setup-reference.mjs';
import { OneBotClient } from '../../capabilities/qq/onebot-client.js';

// Explicit operator audition: fixed synthetic text, no incoming recordings,
// no persona observations, no live voice change, no provider or model loop.
const TEXT = '你回来啦！今天也辛苦了。先歇一会儿吧，想聊什么，我都在听哦！';
const ROUND = 'voice-audition-20261103-01';
const hash = x => createHash('sha256').update(x).digest('hex');
const jsonHash = x => hash(JSON.stringify(x));
const fail = code => Object.assign(new Error(code), { code });
export async function audition({ mode, base = path.join(os.homedir(), '.local/share/companion-world-v1') }) {
  if (!['generate', 'send', 'status'].includes(mode)) throw fail('AUDITION_ARGUMENTS');
  base = fs.realpathSync(base);
  if (path.basename(base) !== 'companion-world-v1') throw fail('AUDITION_BASE');
  const configFile = path.join(base, 'operator/speech.json'), configBytes = fs.readFileSync(configFile), config = JSON.parse(configBytes);
  const stateFile = path.join(base, 'operator', ROUND + '.json');
  const directory = path.join(fs.realpathSync(config.workRoot), ROUND);
  const token = fs.readFileSync(path.join(base, 'operator/console.token'), 'utf8').trim();
  async function snapshot() {
    const response = await fetch('http://127.0.0.1:3082/world', { headers: { authorization: 'Bearer ' + token } });
    const envelope = await response.json(), value = envelope.value;
    if (!response.ok || !envelope.ok || !value.world.paused) throw fail('AUDITION_PAUSE_REQUIRED');
    return { world: { revision: value.world.revision, worldNow: value.world.worldNow, paused: true }, persona: jsonHash(value.persona), counts: jsonHash(value.counts), bindings: jsonHash(value.bindings), speechConfig: hash(fs.readFileSync(configFile)), reference: hash(fs.readFileSync(config.voiceProfiles.default.referencePath)) };
  }
  const before = await snapshot();
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  const unchanged = async () => { if (jsonHash(await snapshot()) !== jsonHash(state.before)) throw fail('AUDITION_FORMAL_STATE_CHANGED'); };
  if (mode === 'generate') {
    if (state) throw fail('AUDITION_ROUND_EXISTS');
    fs.mkdirSync(directory, { mode: 0o700 });
    state = { version: 1, round: ROUND, before, syntheticOnly: true, text: TEXT, createdAt: new Date().toISOString(), status: 'generating', candidates: [], attempts: [] }; save();
    // v1.1-zh mapping: sid3=zf_001, sid10=zf_008, sid24=zf_039.
    // These are verified Chinese-female entries, not claims of a particular
    // perceived personality, age, acting style or user preference.
    const selections = [{ key: 'candidate-one', sid: 3, quality: 'light' }, { key: 'candidate-two', sid: 10, quality: 'light' }, { key: 'candidate-three', sid: 24, quality: 'light' }, { key: 'candidate-four', sid: 3, quality: 'heavy' }];
    const configs = new Map();
    for (const sid of [3, 10, 24]) {
      const c = structuredClone(config); c.voiceProfiles.default.speakerId = sid;
      c.voiceProfiles.default.referencePath = path.join(directory, 'synthetic-reference-' + sid + '.wav');
      const file = path.join(directory, 'config-' + sid + '.json'); fs.writeFileSync(file, JSON.stringify(c), { flag: 'wx', mode: 0o600 }); configs.set(sid, file);
    }
    // Only the reference actually required for the heavy comparison is created.
    await setupSyntheticReference(configs.get(3));
    for (const item of selections) {
      const runner = createLocalSpeechRunner({ configFile: configs.get(item.sid) }), outputFile = path.join(directory, item.key + '.wav'), start = performance.now();
      const value = await runner.synthesize({ text: TEXT, quality: item.quality, voiceProfile: 'default', outputFile });
      // Validate complete output with the existing runner; use the fixed public
      // sentence for a bounded ASR check, not an invented human quotation.
      const checkConfig = structuredClone(config); checkConfig.inputRoots = [directory];
      const checkFile = path.join(directory, item.key + '-asr.json'); fs.writeFileSync(checkFile, JSON.stringify(checkConfig), { flag: 'wx', mode: 0o600 });
      const check = await createLocalSpeechRunner({ configFile: checkFile }).transcribe({ inputFile: outputFile, quality: 'light' });
      if (!/回来/.test(check.text) || !/辛苦/.test(check.text) || !/聊/.test(check.text)) throw fail('AUDITION_SPEECH_CHECK_FAILED');
      state.candidates.push({ ...item, file: outputFile, sha256: hash(fs.readFileSync(outputFile)), durationMs: value.durationMs, elapsedWithCheckMs: Math.round(performance.now() - start), complete: true, checkPassed: true }); save();
    }
    for (let i = state.candidates.length - 1; i > 0; i--) { const j = randomInt(i + 1); [state.candidates[i], state.candidates[j]] = [state.candidates[j], state.candidates[i]]; }
    state.candidates.forEach((item, i) => { item.label = 'ABCD'[i]; });
    await unchanged(); state.status = 'ready'; save();
    return { generated: 4, anonymized: true, allChecked: true, formalStateUnchanged: true, sent: 0 };
  }
  if (!state) throw fail('AUDITION_NOT_GENERATED');
  await unchanged();
  if (mode === 'status') return { status: state.status, generated: state.candidates.length, confirmedAudio: state.attempts.filter(a => a.type === 'record' && a.status === 'sent').length, unknown: state.attempts.some(a => a.status === 'unknown' || a.status === 'sending'), formalStateUnchanged: true };
  if (state.status !== 'ready' || state.attempts.length) throw fail('AUDITION_SEND_ALREADY_ATTEMPTED');
  const qq = JSON.parse(fs.readFileSync(path.join(base, 'operator/qq-bridge.json'), 'utf8')), settings = JSON.parse(fs.readFileSync(qq.settingsFile, 'utf8'));
  // Check every file before any platform action.
  for (const item of state.candidates) if (path.dirname(item.file) !== directory || fs.lstatSync(item.file).isSymbolicLink() || hash(fs.readFileSync(item.file)) !== item.sha256) throw fail('AUDITION_FILE_CHANGED');
  let connectedResolve, connectedReject;
  const connected = new Promise((resolve, reject) => { connectedResolve = resolve; connectedReject = reject; });
  const onebot = new OneBotClient({ url: 'ws://127.0.0.1:3001', token: fs.readFileSync(qq.onebotTokenFile, 'utf8').trim(), onEvent: () => {}, onStatus: ready => { if (ready) connectedResolve(); } });
  const timeout = setTimeout(() => connectedReject(fail('AUDITION_CONNECTION')), 20000); onebot.start();
  try {
    await connected; clearTimeout(timeout);
    const login = await onebot.call('get_login_info');
    if (String(login.user_id) !== settings.expectedSelfId || settings.allowedCallerUID === settings.expectedSelfId) throw fail('AUDITION_ACCOUNT');
    for (const item of state.candidates) for (const type of ['text', 'record']) {
      await unchanged();
      const attempt = { label: item.label, type, status: 'sending' }; state.attempts.push(attempt); save();
      const segment = type === 'text' ? { type: 'text', data: { text: '盲听 ' + item.label + '（下一条语音）' } } : { type: 'record', data: { file: 'base64://' + fs.readFileSync(item.file).toString('base64') } };
      try {
        const receipt = await onebot.call('send_private_msg', { user_id: settings.allowedCallerUID, message: [segment], auto_escape: true });
        if (!/^-?\d{1,20}$/.test(String(receipt.message_id))) throw fail('AUDITION_RECEIPT');
        attempt.status = 'sent'; attempt.messageId = String(receipt.message_id); save();
      } catch { attempt.status = 'unknown'; state.status = 'delivery-unknown'; save(); throw fail('AUDITION_DELIVERY_UNKNOWN'); }
    }
    await unchanged(); state.status = 'sent'; state.sentAt = new Date().toISOString(); save();
    return { confirmedAudio: 4, confirmedLabels: 4, anonymized: true, formalStateUnchanged: true, worldPaused: true, humanAuditioned: false };
  } finally { clearTimeout(timeout); onebot.stop(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { if (process.argv.length !== 3 || !['--generate', '--send', '--status'].includes(process.argv[2])) throw fail('AUDITION_ARGUMENTS'); console.log(JSON.stringify(await audition({ mode: process.argv[2].slice(2) }))); }
  catch (error) { console.error(/^AUDITION_[A-Z_]+$/.test(error.code || '') ? error.code : 'AUDITION_FAILED'); process.exitCode = 1; }
}
