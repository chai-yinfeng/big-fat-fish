// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'web', title: '联网',
  // The model's `read` is the content action `fetch`.
  actions: [
    { name: 'search', mode: 'sync', model: { tool: 'companion_content', input: { query: { required: true } }, rules: ['scopeBound', 'worldGuard', 'derivedNotEvidence'] }, content: { action: 'search', fields: ['query'], source: 'none' } },
    { name: 'read', mode: 'sync', model: { tool: 'companion_content', input: { url: { required: true } }, rules: ['scopeBound', 'worldGuard', 'derivedNotEvidence'] }, content: { action: 'fetch', fields: ['url'], source: 'none' } },
  ],
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
  config: null,
  // Nothing of a search or a page is kept.
  forget: null,
};
