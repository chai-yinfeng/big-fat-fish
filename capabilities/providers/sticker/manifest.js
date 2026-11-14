// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'sticker', title: '表情识别',
  // The first look at a sticker nobody has sent before (the content service caches what a picture is by its hash,
  // so the same sticker is looked at once). Same provider, model and price as `vision`, through the same gateway
  // route marked `purpose: 'sticker'`; that mark comes only from the content service, never from the model.
  actions: [{ name: 'describe', mode: 'sync', model: false }],
  // Its own daily count (not vision's 12): a slot of this ledger row, refused as `daily_limit` once used up. The
  // money stays in the spend meter's `vision` category, so the restricted tier stops it like vision.
  meter: { kind: 'paid', source: 'gateway', unit: 'calls', units: [], dailyLimit: 20, spendCategory: 'vision', stopTier: 'restricted', perPerson: false },
  credentials: [
    { name: 'provider API key', location: 'model-data/settings.json', holder: 'model-gateway' },
    { name: 'inference token', location: 'service-config/inference.token', holder: 'companion-content' },
  ],
  visibility: 'private',
  outputs: [{ type: 'description', derived: 'machine-description' }],
  runtime: { process: 'companion-content', subprocess: false, network: 'model-gateway' },
  operatorConfig: null,
};
