// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'speech-asr', title: '语音识别',
  actions: [{ name: 'transcribe', mode: 'sync', model: { tool: 'companion_content', input: { ref: { required: true } }, rules: ['scopeBound', 'worldGuard', 'derivedNotEvidence'] }, content: { action: 'transcribe', fields: ['ref'], source: 'none' } }],
  // Local and free: the content service reports each run to the ledger (count, seconds of audio
  // heard, elapsed time). Nothing is refused on its account.
  meter: { kind: 'local', source: 'reported', unit: 'calls', units: ['audioSeconds'], dailyLimit: null, spendCategory: null, stopTier: null, perPerson: false },
  credentials: [],
  visibility: 'private',
  outputs: [{ type: 'transcript', derived: 'machine-transcript' }],
  runtime: { process: 'companion-content', subprocess: true, network: false },
  operatorConfig: 'operator/speech.json',
  // Where that file is read and checked: `load` is an export of `module`.
  config: { file: 'operator/speech.json', module: 'capabilities/speech/config.js', load: 'loadSpeechConfig' },
  forget: { owner: 'companion-content', what: 'the recording and its transcript' },
};
