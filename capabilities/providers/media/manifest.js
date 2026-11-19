// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'media', title: '素材',
  // The files of a conversation as the channel and the model handle them (capabilities/media/service.js): the channel
  // brings one in (`ingest`), reads one back to send it (`asset`) and collects what the reply queued (`pending`); the
  // model queues a picture or sticker for this reply (`attach`), which is never a delivery.
  actions: [
    { name: 'ingest', mode: 'sync', model: false, content: { action: 'ingest', fields: ['kind', 'data', 'sourceEventId'], source: 'required' } },
    { name: 'asset', mode: 'sync', model: false, content: { action: 'asset', fields: ['ref'], source: 'none' } },
    { name: 'attach', mode: 'sync', model: { tool: 'companion_content', input: { ref: { required: true } }, rules: ['scopeBound', 'worldGuard', 'requestBound', 'queuedNotDelivered', 'derivedNotEvidence'] }, content: { action: 'attach', fields: ['ref', 'requestId'], source: 'none' } },
    { name: 'pending', mode: 'sync', model: false, content: { action: 'pending', fields: ['requestId'], source: 'none' } },
  ],
  // Not metered: no ledger row.
  meter: null,
  credentials: [],
  visibility: 'private',
  outputs: [{ type: 'artifact', derived: null }],
  runtime: { process: 'companion-content', subprocess: false, network: false },
  operatorConfig: null,
  config: null,
  forget: { owner: 'companion-content', what: 'the files brought in with the forgotten message and everything derived from them' },
};
