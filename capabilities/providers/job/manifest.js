// Declaration only (see ../index.js): data, no behaviour.
export default {
  id: 'job', title: '后台任务',
  // The result of a finished background job (capabilities/media/jobs.js), read by the channel for the turn that tells
  // the person. Registering a job is not an action of /v1/content: a capability's own action does it (`video`), or the
  // operator (`demo`).
  actions: [{ name: 'result', mode: 'sync', model: false, content: { action: 'jobResult', fields: ['ref'], source: 'none' } }],
  // Not metered: no ledger row.
  meter: null,
  credentials: [],
  visibility: 'private',
  outputs: [{ type: 'note', derived: 'machine-note' }],
  runtime: { process: 'companion-content', subprocess: false, network: false },
  operatorConfig: null,
  config: null,
  forget: { owner: 'companion-content', what: 'job records registered under the forgotten message, with their results' },
};
