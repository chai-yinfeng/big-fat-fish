// Declaration only (see ../index.js): data, no behaviour. The implementation is ./provider.js, run by the content service.
export default {
  id: 'video', title: '看视频',
  // A video somebody shared as a link: fetched with yt-dlp, listened to with the local speech recognizer and filed as
  // a machine-made note; on request (or when it has no usable voice) a few stills are looked at too. `tool` names the model tool these actions are offered through (companion_activity); the
  // tool's choices are generated from the declarations that carry it.
  actions: [
    { name: 'watch', mode: 'background', model: true, tool: 'companion_activity' },
    { name: 'status', mode: 'sync', model: true, tool: 'companion_activity' },
    { name: 'page', mode: 'sync', model: true, tool: 'companion_activity' },
    // A few stills of the video this conversation watched last, looked at by the vision model (a background job; the
    // stills' calls are the `video-frame` row's). Also done inside `watch` when the video has no usable voice.
    { name: 'frames', mode: 'background', model: true, tool: 'companion_activity' },
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
};
