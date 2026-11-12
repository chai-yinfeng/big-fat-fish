// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'vision', title: '看图',
  actions: [{ name: 'describe', mode: 'sync', model: true }],
  // The daily count is still kept in the gateway's capability-usage.json (`legacyCounter`), which the
  // previous release also reads; the ledger shows that number and adds outcome, cost and time.
  meter: { kind: 'paid', source: 'gateway', unit: 'calls', units: [], dailyLimit: 12, legacyCounter: 'visionCalls', spendCategory: 'vision', stopTier: 'restricted', perPerson: false },
  credentials: [
    { name: 'provider API key', location: 'model-data/settings.json', holder: 'model-gateway' },
    { name: 'inference token', location: 'service-config/inference.token', holder: 'companion-content' },
  ],
  visibility: 'private',
  outputs: [{ type: 'description', derived: 'machine-description' }],
  runtime: { process: 'companion-content', subprocess: false, network: 'model-gateway' },
  operatorConfig: null,
};
