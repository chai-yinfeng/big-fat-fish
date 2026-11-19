// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'speech-tts', title: '语音合成',
  // Synthesis is the channel adapter's action (the person asked to hear her), not a model tool.
  actions: [{ name: 'synthesize', mode: 'sync', model: false, content: { action: 'synthesize', fields: ['text', 'voiceProfile', 'sourceEventId'], source: 'required' } }],
  // Local and free: the content service reports each run to the ledger (count, characters spoken,
  // seconds of audio produced, elapsed time). Nothing is refused on its account.
  meter: { kind: 'local', source: 'reported', unit: 'calls', units: ['chars', 'audioSeconds'], dailyLimit: null, spendCategory: null, stopTier: null, perPerson: false },
  credentials: [{ name: 'voice reference recordings', location: 'speech-data/', holder: 'companion-content' }],
  visibility: 'private',
  outputs: [{ type: 'audio', derived: 'synthesized-speech' }],
  runtime: { process: 'companion-content', subprocess: true, network: false },
  operatorConfig: 'operator/speech.json',
  // Where that file is read and checked: `load` is an export of `module`.
  config: { file: 'operator/speech.json', module: 'capabilities/speech/config.js', load: 'loadSpeechConfig' },
  forget: { owner: 'companion-content', what: 'audio synthesized in answer to the forgotten message' },
};
