// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'web', title: '联网',
  // The model's `read` is the content action `fetch`. Its `page` reads on in a page this conversation read before; the
  // source (the message of this turn, when there is one) is what the kept text is filed under.
  actions: [
    { name: 'search', mode: 'sync', model: { tool: 'companion_content', input: { query: { required: true } }, rules: ['scopeBound', 'worldGuard', 'derivedNotEvidence'] }, content: { action: 'search', fields: ['query'], source: 'none' } },
    { name: 'read', mode: 'sync', model: { tool: 'companion_content', input: { url: { required: true }, page: { required: false } }, rules: ['scopeBound', 'worldGuard', 'sourceFromEvidenceIfAny', 'derivedNotEvidence'] }, content: { action: 'fetch', fields: ['url', 'page', 'sourceEventId'], source: 'optional' } },
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
  // Nothing of a search is kept. A page's text is kept for its conversation only, a few hours (capabilities/media/service.js
  // WEB_PAGE), under the message that asked for it.
  forget: { owner: 'companion-content', what: 'the text of pages read in answer to the forgotten message' },
};
