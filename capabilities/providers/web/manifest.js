// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'web', title: '联网',
  actions: [{ name: 'search', mode: 'sync', model: true }, { name: 'read', mode: 'sync', model: true }],
  // Search and page reads share one daily count, still kept in capability-usage.json (`legacyCounter`).
  meter: { kind: 'paid', source: 'gateway', unit: 'calls', units: [], dailyLimit: 20, legacyCounter: 'webCalls', spendCategory: 'web', stopTier: 'restricted', perPerson: false },
  credentials: [
    { name: 'provider API key', location: 'model-data/settings.json', holder: 'model-gateway' },
    { name: 'inference token', location: 'service-config/inference.token', holder: 'companion-content' },
  ],
  visibility: 'private',
  outputs: [{ type: 'search-results', derived: 'external-content' }, { type: 'page', derived: 'external-content' }],
  runtime: { process: 'companion-content', subprocess: false, network: 'model-gateway' },
  operatorConfig: null,
};
