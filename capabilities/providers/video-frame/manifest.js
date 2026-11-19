// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'video-frame', title: '视频静帧',
  // A still of a shared video looked at by the vision model (capabilities/providers/video): when she is asked about the
  // picture (`video / frames`), or when the video has no usable voice. Same provider, model and price as `vision`,
  // through the same gateway route marked `purpose: 'frame'`. That mark is set by the content service; the gateway
  // does not tell its callers apart by credential (they share the inference token). What keeps the model from setting
  // it is the tool layer: none of the model's tools has a field that reaches the gateway's `purpose`.
  actions: [{ name: 'describe', mode: 'background', model: false, content: null }],
  // Its own daily count (not vision's 12): a slot of this ledger row per still, refused as `daily_limit` once used up.
  // At most `framesPerVideo` (operator/providers/video.json `limits`, default 3) stills of one video, counted by the
  // content service. The money stays in the spend meter's `vision` category, so the restricted tier stops it.
  meter: { kind: 'paid', source: 'gateway', unit: 'calls', units: [], dailyLimit: 6, spendCategory: 'vision', stopTier: 'restricted', perPerson: false, via: { capability: 'vision', purpose: 'frame' } },
  credentials: [
    { name: 'provider API key', location: 'model-data/settings.json', holder: 'model-gateway' },
    { name: 'inference token', location: 'service-config/inference.token', holder: 'companion-content' },
  ],
  visibility: 'private',
  outputs: [{ type: 'description', derived: 'machine-description' }],
  runtime: { process: 'companion-content', subprocess: false, network: 'model-gateway' },
  operatorConfig: null,
  config: null,
  forget: { owner: 'companion-content', what: 'the note reference filed under the forgotten message' },
};
