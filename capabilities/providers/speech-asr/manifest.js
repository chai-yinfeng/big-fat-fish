// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'speech-asr', title: '语音识别',
  actions: [{ name: 'transcribe', mode: 'sync', model: true }],
  // Local and free: the content service reports each run to the ledger (count, seconds of audio
  // heard, elapsed time). Nothing is refused on its account.
  meter: { kind: 'local', source: 'reported', unit: 'calls', units: ['audioSeconds'], dailyLimit: null, spendCategory: null, stopTier: null, perPerson: false },
  credentials: [],
  visibility: 'private',
  outputs: [{ type: 'transcript', derived: 'machine-transcript' }],
  runtime: { process: 'companion-content', subprocess: true, network: false },
  operatorConfig: 'operator/speech.json',
};
