// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'chat', title: '聊天',
  // A conversation turn is driven by the channel, not called by the model.
  actions: [{ name: 'turn', mode: 'sync', model: false }],
  // Counted by the model gateway itself, one per chat-completion request (a turn makes 1–12), with the
  // tokens the provider reported. dailyLimit null: bounded by the daily spend cap only, refused at the 100% tier.
  meter: { kind: 'paid', source: 'gateway', unit: 'requests', units: ['inputTokens', 'outputTokens'], dailyLimit: null, spendCategory: 'conversation', stopTier: 'exhausted', perPerson: false },
  credentials: [
    { name: 'provider API key', location: 'model-data/settings.json', holder: 'model-gateway' },
    { name: 'inference token', location: 'service-config/inference.token', holder: 'companion-conversation' },
  ],
  visibility: 'private',
  outputs: [{ type: 'reply', derived: null }],
  runtime: { process: 'companion-conversation', subprocess: false, network: 'model-gateway' },
  operatorConfig: null,
};
