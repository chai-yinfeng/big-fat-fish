// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'sticker-library', title: '表情库',
  // Her own sticker library (capabilities/media/stickers.js), as the channel uses it: the owner says "keep this"
  // (`keep`), and a `[表情:词]` of her reply is matched to a picture (`pick`). Looking at a sticker is the `sticker` row.
  actions: [
    { name: 'keep', mode: 'sync', model: false, content: { action: 'stickerKeep', fields: ['ref'], source: 'none' } },
    { name: 'pick', mode: 'sync', model: false, content: { action: 'stickerPick', fields: ['query', 'sourceEventId'], source: 'required' } },
  ],
  // Not metered: no ledger row.
  meter: null,
  credentials: [],
  visibility: 'private',
  outputs: [{ type: 'image', derived: null }],
  runtime: { process: 'companion-content', subprocess: false, network: false },
  operatorConfig: null,
  config: null,
  forget: { owner: 'companion-content', what: 'the senders counted from the forgotten message, and a picture nobody else sent or kept' },
};
