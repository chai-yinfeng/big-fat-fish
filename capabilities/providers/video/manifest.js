// Declaration only (see ../index.js): data, no behaviour. The implementation is ./provider.js, run by the content service.
export default {
  id: 'video', title: '看视频',
  // A video somebody shared as a link: fetched with yt-dlp, listened to with the local speech recognizer and filed as
  // a machine-made note; on request (or when it has no usable voice) a few stills are looked at too. `model.tool` names the model tool these actions are offered through (companion_activity); the
  // tool's definition is generated from the declarations that carry it (../index.js ACTIVITY_TOOL_DEFINITION): `description` is the
  // action's part of the tool description, `input` the fields of the tool's `input` it takes (`schema` and `description` are
  // shown to the model, `required` and `max` are for the executor's check), `rules` the named rules of the tool layer
  // (capabilities/conversation/tool-rules.js). Changing `description` or `schema` changes the tool definition (prompt cache).
  actions: [
    { name: 'watch', mode: 'background', content: { action: 'activity', fields: ['capability', 'activity', 'input', 'sourceEventId', 'requestId'], source: 'required' }, model: { tool: 'companion_activity',
      description: 'starts watching a video whose link the other person sent in this very message (background work: say now that you will have a look; you are told when it is done, or get the note at once if you have seen it before)',
      input: { url: { required: true, schema: { type: 'string', maxLength: 2048 }, description: 'the video link, copied exactly as it appears in this message.' } }, rules: ['scopeBound', 'worldGuard', 'notInitiated', 'linkFromThisMessage', 'sourceFromEvidence', 'requestBound', 'neutralizeExternalText', 'derivedNotEvidence'] } },
    { name: 'status', mode: 'sync', content: { action: 'activity', fields: ['capability', 'activity', 'input'], source: 'none' }, model: { tool: 'companion_activity', description: 'asks how that is going', input: {}, rules: ['scopeBound', 'worldGuard', 'notInitiated', 'neutralizeExternalText', 'derivedNotEvidence'] } },
    { name: 'page', mode: 'sync', content: { action: 'activity', fields: ['capability', 'activity', 'input'], source: 'none' }, model: { tool: 'companion_activity', description: 'reads the full machine transcript of the last video you watched here, page by page',
      input: { page: { required: false, schema: { type: 'integer', minimum: 1 }, description: 'which page, from 1.', max: 999 } }, rules: ['scopeBound', 'worldGuard', 'notInitiated', 'neutralizeExternalText', 'derivedNotEvidence'] } },
    // A few stills of the video this conversation watched last, looked at by the vision model (a background job; the
    // stills' calls are the `video-frame` row's). Also done inside `watch` when the video has no usable voice.
    // `job`: the content service's job kind it runs as (capabilities/media/jobs.js), when that is not the capability's
    // id. Kept as it is because job records (jobs.json) carry it; it is not a ledger row (the job itself is not counted).
    { name: 'frames', mode: 'background', job: 'video-frames', content: { action: 'activity', fields: ['capability', 'activity', 'input'], source: 'none' }, model: { tool: 'companion_activity',
      description: 'looks at a few stills of that same video (only when asked about the picture, or there is nothing else to go on; background work unless looked at before)', input: {}, rules: ['scopeBound', 'worldGuard', 'notInitiated', 'neutralizeExternalText', 'derivedNotEvidence'] } },
  ],
  // Local work. The content service takes one of the day's slots before a new video is queued (refused:
  // `daily_limit`); a video already in the cache takes none. The money of the summary is the `video-note` row's.
  meter: { kind: 'local', source: 'reported', unit: 'calls', units: [], dailyLimit: 6, spendCategory: null, stopTier: null, perPerson: false },
  credentials: [],
  visibility: 'private',
  outputs: [{ type: 'note', derived: 'machine-note' }, { type: 'transcript', derived: 'machine-transcript' }],
  // yt-dlp and ffmpeg run as child processes inside bubblewrap where the operator configured it: the runtime read-only,
  // one writable work directory per job, no view of the data root; only yt-dlp keeps the network.
  runtime: { process: 'companion-content', subprocess: true, network: 'operator-listed video sites', sandbox: 'bwrap' },
  // Everything about a particular site (link patterns, hosts to skip, what "blocked" looks like) lives here, in the
  // data root, never in this repository.
  operatorConfig: 'operator/providers/video.json',
  // Where that file is read and checked: `load` is an export of `module`.
  config: { file: 'operator/providers/video.json', module: 'capabilities/providers/video/config.js', load: 'load' },
  forget: { owner: 'companion-content', what: 'the note reference and the jobs registered under the forgotten message' },
};
