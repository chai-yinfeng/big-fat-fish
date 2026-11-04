#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { OneBotClient } from '../../capabilities/qq/onebot-client.js';
import { ArtifactStore } from '../../capabilities/media/artifacts.js';
import { createLocalSpeechRunner } from '../../capabilities/speech/runner.js';

// Explicit operator probe only: two fixed synthetic media messages, no model
// inference, no history replay, no Authority observation/personality update.
export async function verifyMedia({ base = path.join(os.homedir(), '.local/share/companion-world-v1'), send = false }) {
  base = fs.realpathSync(base);
  if (path.basename(base) !== 'companion-world-v1') throw Error('QQ_MEDIA_PROBE_BASE');
  const read = file => JSON.parse(fs.readFileSync(path.join(base, file), 'utf8'));
  const speech = read('operator/speech.json'), qq = read('operator/qq-bridge.json'), settings = JSON.parse(fs.readFileSync(qq.settingsFile, 'utf8'));
  const report = read('operator/speech-benchmarks.json'), benchmark = report.results['tts:light'];
  if (!benchmark?.passed || typeof benchmark.artifact !== 'string') throw Error('QQ_MEDIA_PROBE_NEEDS_BENCHMARK');
  if (!send) return { planned: true, messages: 2, syntheticOnly: true, modelCalls: 0, voice: true, image: true };
  const headers = { authorization: 'Bearer ' + fs.readFileSync(path.join(base, 'operator/console.token'), 'utf8').trim() };
  const world = async () => { const r = await fetch('http://127.0.0.1:3082/world', { headers }); const v = await r.json(); if (!r.ok || !v.ok || !v.value.world.paused) throw Error('QQ_MEDIA_PROBE_REQUIRES_PAUSE'); return v.value.world; };
  await world();
  const receiptFile = path.join(base, 'operator/qq-media-probe.json');
  if (fs.existsSync(receiptFile)) throw Error('QQ_MEDIA_PROBE_ALREADY_ATTEMPTED');
  const store = new ArtifactStore({ root: speech.inputRoots[0] }), scope = { entityId: 'operator:benchmark', streamId: 'operator:benchmark', personId: 'operator:benchmark', audience: 'private' };
  const audio = store.read(benchmark.artifact, scope);
  if (audio.meta.kind !== 'audio' || !audio.meta.sourceEventId.startsWith('operator:benchmark:')) throw Error('QQ_MEDIA_PROBE_SYNTHETIC_ONLY');
  const sharpModule = path.join(path.dirname(path.dirname(speech.sherpaModule)), 'sharp'), sharp = createRequire(import.meta.url)(sharpModule);
  const image = await sharp({ create: { width: 256, height: 128, channels: 3, background: '#2d6cdf' } }).png().toBuffer();
  const state = { schemaVersion: 1, syntheticOnly: true, coreObserved: false, attempts: [], createdAt: new Date().toISOString() };
  const save = () => fs.writeFileSync(receiptFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  let finishConnection, failConnection;
  const connected = new Promise((resolve, reject) => { finishConnection = resolve; failConnection = reject; });
  const onebot = new OneBotClient({ url: 'ws://127.0.0.1:3001', token: fs.readFileSync(qq.onebotTokenFile, 'utf8').trim(), onEvent: () => {}, onStatus: ready => { if (ready) finishConnection(); } });
  const timeout = setTimeout(() => failConnection(Error('QQ_MEDIA_PROBE_CONNECTION')), 20000);
  onebot.start();
  try {
    await connected; clearTimeout(timeout);
    const self = await onebot.call('get_login_info');
    if (String(self.user_id) !== settings.expectedSelfId || settings.allowedCallerUID === settings.expectedSelfId) throw Error('QQ_MEDIA_PROBE_ACCOUNT');
    for (const [type, bytes] of [['record', audio.data], ['image', image]]) {
      await world();
      const row = { type, state: 'sending' }; state.attempts.push(row); save();
      try {
        const receipt = await onebot.call('send_private_msg', { user_id: settings.allowedCallerUID, message: [{ type, data: { file: 'base64://' + bytes.toString('base64') } }], auto_escape: true });
        if (!/^-?\d{1,20}$/.test(String(receipt.message_id))) throw Error('QQ_MEDIA_PROBE_RECEIPT');
        row.state = 'sent'; row.messageId = String(receipt.message_id); save();
      } catch { row.state = 'unknown'; save(); throw Error('QQ_MEDIA_PROBE_DELIVERY_UNKNOWN'); }
    }
    // Decode this newly sent synthetic record through NapCat as a file input;
    // this never subscribes to or reads the person's existing private messages.
    try {
      const message = await onebot.call('get_msg', { message_id: state.attempts[0].messageId });
      const record = message.message?.find(s => s.type === 'record');
      if (typeof record?.data?.file !== 'string') throw Error('MISSING_RECORD');
      const decoded = await onebot.call('get_record', { file: record.data.file, out_format: 'wav' });
      if (typeof decoded.base64 !== 'string') throw Error('MISSING_AUDIO');
      const input = store.put({ scope, sourceEventId: 'operator:qq-media-probe', kind: 'audio', mime: 'audio/wav', data: Buffer.from(decoded.base64, 'base64') });
      const value = await createLocalSpeechRunner({ configFile: path.join(base, 'operator/speech.json') }).transcribe({ inputFile: store.read(input.id, scope).file, quality: 'light' });
      state.platformVoiceDecoded = true; state.asrRecognizedTestWords = /你好/.test(value.text) && /测试/.test(value.text); save();
    } catch { state.platformVoiceDecoded = false; save(); }
    await world();
    return { voiceSent: state.attempts[0].state === 'sent', imageSent: state.attempts[1].state === 'sent', platformVoiceDecoded: state.platformVoiceDecoded, asrRecognizedTestWords: state.asrRecognizedTestWords === true, syntheticOnly: true, worldPaused: true, coreObserved: false, humanAuditioned: false };
  } finally { clearTimeout(timeout); onebot.stop(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2); if (args.some(a => !['--send', '--plan'].includes(a))) throw Error('QQ_MEDIA_PROBE_ARGUMENTS');
    console.log(JSON.stringify(await verifyMedia({ send: args.includes('--send') })));
  } catch (error) { console.error(/^QQ_MEDIA_PROBE_[A-Z_]+$/.test(error.message) ? error.message : 'QQ_MEDIA_PROBE_FAILED'); process.exitCode = 1; }
}
