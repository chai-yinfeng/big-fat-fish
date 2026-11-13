// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'consolidation', title: '后台整合',
  actions: [{ name: 'batch', mode: 'background', model: false }],
  // Counted by the model gateway, one per maintenance completion (/v1/memory/completions: per-person
  // consolidation and the legacy auto diary). The daily batch limits (2 per conversation, 24 in all)
  // are Authority's and are read from operator GET /memory/consolidation, so dailyLimit is null here.
  meter: { kind: 'paid', source: 'gateway', unit: 'requests', units: ['inputTokens', 'outputTokens'], dailyLimit: null, spendCategory: 'maintenance', stopTier: 'restricted', perPerson: false },
  credentials: [
    { name: 'provider API key', location: 'model-data/settings.json', holder: 'model-gateway' },
    { name: 'inference token', location: 'service-config/inference.token', holder: 'companion-memory' },
    { name: 'maintenance token', location: 'memory-config/', holder: 'companion-memory' },
  ],
  visibility: 'private',
  outputs: [{ type: 'digest', derived: 'machine-summary' }, { type: 'fact', derived: 'machine-extracted' }],
  runtime: { process: 'companion-memory', subprocess: false, network: 'model-gateway' },
  operatorConfig: null,
};
