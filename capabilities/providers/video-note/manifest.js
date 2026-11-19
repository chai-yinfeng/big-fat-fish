// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'video-note', title: '视频摘要',
  // The model call that turns a video's machine transcript into a short summary (capabilities/providers/video).
  // Made by the content service through the gateway's /v1/activity/completions: no tools, thinking off. Not something
  // the model calls. Refused by the spend tier, the note is filed without a summary instead.
  actions: [{ name: 'summarize', mode: 'background', model: false }],
  meter: { kind: 'paid', source: 'gateway', unit: 'requests', units: ['inputTokens', 'outputTokens'], dailyLimit: null, spendCategory: 'activity', stopTier: 'restricted', perPerson: false },
  credentials: [
    { name: 'provider API key', location: 'model-data/settings.json', holder: 'model-gateway' },
    { name: 'inference token', location: 'service-config/inference.token', holder: 'companion-content' },
  ],
  visibility: 'private',
  outputs: [{ type: 'note', derived: 'machine-summary' }],
  runtime: { process: 'companion-content', subprocess: false, network: 'model-gateway' },
  operatorConfig: null,
};
