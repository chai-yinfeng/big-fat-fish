// Staging- and test-only provider adapter "mock": what a real adapter in model-gateway/providers/ looks
// like, against an upstream that exists only in this file. It is not part of a release (deploy/staging is
// never copied into one) and the release's own adapter list is fixed in code; only an embedding launcher
// (fake-model.mjs, the unit tests) can hand it to createModelGateway. Uploaded next to fake-model.mjs.
//   mock.generate  async: submit -> a task; the first poll says running, the second succeeded with one file
//                  URL that must be fetched with the key (the shape of Replicate / Seedance)
//   mock.sketch    sync: the submit answers with one base64 picture (the shape of the image APIs)
// The upstream accepts only a key starting with MOCK-. A prompt containing "MOCK-FAIL" makes the task fail,
// "MOCK-REFUSE" makes the provider refuse the submit with 429.

export const FAKE_HOST = 'provider.mock.invalid';
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const api = path => `https://${FAKE_HOST}${path}`;
const headers = key => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
const prompt = input => { if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 200 || Object.keys(input).some(name => name !== 'prompt')) throw new Error('Invalid mock input'); return input.prompt; };

/** The declaration of the capability the mock operations are counted under (capabilities/providers shape). */
export const FAKE_CAPABILITY = {
  id: 'mock', title: 'MOCK 生成',
  actions: [{ name: 'generate', mode: 'background', model: false }, { name: 'sketch', mode: 'sync', model: false }],
  meter: { kind: 'paid', source: 'gateway', unit: 'calls', units: ['files'], dailyLimit: 3, spendCategory: 'generation', stopTier: 'restricted', perPerson: false },
  credentials: [{ name: 'provider API key', location: 'model-data/providers.json', holder: 'model-gateway' }],
  visibility: 'private',
  outputs: [{ type: 'file', derived: 'generated' }],
  runtime: { process: 'model-gateway', subprocess: false, network: 'provider' },
  operatorConfig: null,
};

export const FAKE_PROVIDER = {
  id: 'mock', title: 'MOCK provider', hosts: [FAKE_HOST], proxy: false,
  operations: {
    'mock.generate': {
      mode: 'async',
      estimate(input) { prompt(input); return 20000; },
      submit: (input, key) => ({ url: api('/v1/tasks'), method: 'POST', headers: headers(key), body: JSON.stringify({ prompt: prompt(input) }) }),
      submitted: json => ({ state: 'pending', task: json.id }),
      poll: (task, key) => ({ url: api('/v1/tasks/' + encodeURIComponent(task)), headers: headers(key) }),
      polled(json, key) {
        if (['queued', 'running'].includes(json.status)) return { state: 'pending' };
        if (json.status !== 'succeeded') return { state: 'failed' };
        // The provider reports what the task cost (here 0.012 CNY); the estimate above was 0.02.
        return { state: 'done', outputs: [{ url: json.output, headers: { authorization: `Bearer ${key}` } }], costMicros: json.cost_micros, units: { files: 1 } };
      },
    },
    'mock.sketch': {
      mode: 'sync',
      estimate(input) { prompt(input); return 4000; },
      submit: (input, key) => ({ url: api('/v1/sketches'), method: 'POST', headers: headers(key), body: JSON.stringify({ prompt: prompt(input) }) }),
      // No cost in the answer: the estimate is charged.
      submitted: json => ({ state: 'done', outputs: json.data.map(item => ({ base64: item.b64_json, mime: 'image/png' })), units: { files: json.data.length } }),
    },
  },
};

/** fetch stand-in for the mock provider's host; null for any other URL. `log(entry)` gets one line per request (no key). */
export function createFakeProviderUpstream(log = () => {}) {
  const tasks = new Map();
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  return async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.hostname !== FAKE_HOST && !target.hostname.endsWith('.' + FAKE_HOST)) return null;
    const method = options.method ?? 'GET', route = target.pathname;
    log({ provider: 'mock', method, route });
    if (!/^Bearer MOCK-/.test(new Headers(options.headers).get('authorization') ?? '')) return json(401, {});
    if (method === 'POST' && ['/v1/tasks', '/v1/sketches'].includes(route)) {
      const text = String(JSON.parse(options.body)?.prompt ?? '');
      if (text.includes('MOCK-REFUSE')) return json(429, {});
      if (route === '/v1/sketches') return json(200, { data: [{ b64_json: PNG }] });
      const id = 'mock-task-' + (tasks.size + 1);
      tasks.set(id, { polls: 0, fail: text.includes('MOCK-FAIL') });
      return json(200, { id, status: 'queued' });
    }
    const task = method === 'GET' ? tasks.get(/^\/v1\/tasks\/([a-z0-9-]+)$/.exec(route)?.[1]) : undefined;
    if (task) {
      task.polls++;
      if (task.polls < 2) return json(200, { status: 'running' });
      return json(200, task.fail ? { status: 'failed' } : { status: 'succeeded', output: `https://files.${FAKE_HOST}/mock.png`, cost_micros: 12000 });
    }
    if (method === 'GET' && target.hostname === 'files.' + FAKE_HOST && route === '/mock.png') return new Response(Buffer.from(PNG, 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
    return json(404, {});
  };
}
