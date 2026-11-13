// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'proactive', title: '主动开口',
  // A turn she starts herself (an initiated run): driven by Authority and the channel, not called by the model.
  actions: [{ name: 'turn', mode: 'sync', model: false }],
  // Counted by the model gateway, one per chat-completion request of an initiated run (the executor marks them),
  // with the tokens the provider reported. Its own spend category, the first to stop: refused from the 60% tier,
  // before the provider is contacted. dailyLimit null: how often she may start is Authority's to decide.
  meter: { kind: 'paid', source: 'gateway', unit: 'requests', units: ['inputTokens', 'outputTokens'], dailyLimit: null, spendCategory: 'proactive', stopTier: 'reduced', perPerson: false },
  credentials: [
    { name: 'provider API key', location: 'model-data/settings.json', holder: 'model-gateway' },
    { name: 'inference token', location: 'service-config/inference.token', holder: 'companion-conversation' },
  ],
  visibility: 'private',
  outputs: [{ type: 'reply', derived: null }],
  runtime: { process: 'companion-conversation', subprocess: false, network: 'model-gateway' },
  operatorConfig: null,
};
