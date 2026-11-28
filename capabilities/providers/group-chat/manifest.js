// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'group-chat', title: '群聊',
  // A turn in a group conversation she was called in: driven by the channel, not called by the model.
  actions: [{ name: 'turn', mode: 'sync', model: false, content: null }],
  // Counted by the model gateway, one per chat-completion request of a group run (the executor marks them), with the
  // tokens the provider reported. Its own spend category: refused from the 80% tier on, before the provider is
  // contacted, so a busy group cannot use up what private chat needs. dailyLimit null: how often she answers in a
  // group is the bridge's to bound (capabilities/qq/group.js).
  meter: { kind: 'paid', source: 'gateway', unit: 'requests', units: ['inputTokens', 'outputTokens'], dailyLimit: null, spendCategory: 'group', stopTier: 'restricted', perPerson: false },
  credentials: [
    { name: 'provider API key', location: 'model-data/settings.json', holder: 'model-gateway' },
    { name: 'inference token', location: 'service-config/inference.token', holder: 'companion-conversation' },
  ],
  visibility: 'private',
  outputs: [{ type: 'reply', derived: null }],
  runtime: { process: 'companion-conversation', subprocess: false, network: 'model-gateway' },
  operatorConfig: null,
  config: null,
  forget: { owner: 'companion-conversation', what: 'session files of the conversations the forgotten message was in' },
};
