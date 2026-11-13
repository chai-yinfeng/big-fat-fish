// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'demo', title: '演示任务',
  // A background job that waits a few seconds and returns a fixed text (capabilities/media/demo-job.js): it walks
  // the job path end to end. Registered by the operator from the console, not called by the model.
  actions: [{ name: 'wait', mode: 'background', model: false }],
  // Local and free. The content service takes one of the day's slots before a job is queued (refused: `daily_limit`),
  // reports a full queue as `busy`, and reports how each job ended with the time it took.
  meter: { kind: 'local', source: 'reported', unit: 'calls', units: [], dailyLimit: 10, spendCategory: null, stopTier: null, perPerson: false },
  credentials: [],
  visibility: 'private',
  outputs: [{ type: 'note', derived: 'fixed-text' }],
  runtime: { process: 'companion-content', subprocess: false, network: false },
  operatorConfig: null,
};
