import http from 'node:http';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const fail = code => Object.assign(new Error(code), { code });

/** Fixed gateway model: the gateway rewrites `deepseek` to the configured real
 * model and forces thinking. Compat mirrors DeepSeek's chat-completions rules,
 * including replaying reasoning_content on assistant messages. */
export const GATEWAY_MODEL = Object.freeze({
  id: 'deepseek', name: '大肥鱼 · DeepSeek', api: 'openai-completions', provider: 'companion',
  // Never resolved by DNS: every request goes through the Unix-socket fetch below.
  baseUrl: 'http://model-gateway.invalid/v1',
  reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536, maxTokens: 4096,
  compat: {
    thinkingFormat: 'deepseek', supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens',
    requiresReasoningContentOnAssistantMessages: true, supportsReasoningEffort: true, supportsStrictMode: false,
  },
});

/** WHATWG fetch over one fixed Unix socket; the URL host is ignored. */
export function unixSocketFetch(socketPath) {
  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body = init.body;
    if (body === undefined || body === null) body = undefined;
    else if (typeof body === 'string' || body instanceof Uint8Array) body = Buffer.from(body);
    else if (body instanceof ArrayBuffer) body = Buffer.from(new Uint8Array(body));
    else { reject(fail('GATEWAY_BODY_UNSUPPORTED')); return; }
    if (body) headers['content-length'] = String(body.length);
    const request = http.request({ socketPath, path: url.pathname + url.search, method: init.method || 'GET', headers, agent: false, signal: init.signal }, response => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      const empty = [204, 205, 304].includes(response.statusCode);
      if (empty) response.resume();
      resolve(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, headers: responseHeaders }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

/** Stream function for pi-agent-core that reaches only the private gateway. */
export function createGatewayStream({ socketPath, tokenFile }) {
  const models = createModels();
  models.setProvider(createProvider({
    id: 'companion', name: 'Companion gateway', baseUrl: GATEWAY_MODEL.baseUrl,
    auth: { apiKey: { name: 'Companion gateway', resolve: async () => ({ auth: {} }) } },
    models: [GATEWAY_MODEL], api: openAICompletionsApi(),
  }));
  const model = models.getModel('companion', 'deepseek');
  if (!model) throw fail('GATEWAY_MODEL_UNAVAILABLE');
  const fetch = unixSocketFetch(socketPath);
  const token = () => {
    const value = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw fail('GATEWAY_CREDENTIAL_UNAVAILABLE');
    return value;
  };
  // Report the gateway's fixed refusal code (429 BUDGET_EXHAUSTED) to the run; body bytes are untouched.
  const observed = report => async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 429) {
      try { const code = (await response.clone().json())?.error?.code; if (typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code)) report(code); } catch {}
    }
    return response;
  };
  // No provider retries: a retried completion may be billed twice.
  return { model, streamFn: (m, context, { gatewayFailure, ...options } = {}) => models.streamSimple(m, context, { ...options, apiKey: token(), fetch: typeof gatewayFailure === 'function' ? observed(gatewayFailure) : fetch, maxRetries: 0 }) };
}
