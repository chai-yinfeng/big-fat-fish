import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

/**
 * A fetch for the provider adapters that must leave through the host's outbound HTTP proxy (the global
 * fetch has no per-request proxy without a dependency). Standard library only: node:http(s) with an
 * Agent's `proxyEnv` (Node >= 24.5). It covers what model-gateway/providers.mjs sends: method, headers,
 * a string body and an abort signal; a redirect is returned as it is, never followed.
 */
export function createProxyFetch(proxy) {
  const url = new URL(proxy);
  if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Invalid outbound proxy');
  const agents = { 'http:': new http.Agent({ proxyEnv: { HTTP_PROXY: url.origin } }), 'https:': new https.Agent({ proxyEnv: { HTTPS_PROXY: url.origin } }) };
  return (target, { method = 'GET', headers = {}, body, signal } = {}) => new Promise((resolve, reject) => {
    const { protocol } = new URL(target);
    const request = (protocol === 'https:' ? https : http).request(target, { method, headers, agent: agents[protocol], signal }, response => {
      const empty = [204, 205, 304].includes(response.statusCode) || method === 'HEAD';
      if (empty) response.resume();
      try { resolve(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, headers: Object.entries(response.headers).flatMap(([name, value]) => [].concat(value).map(item => [name, item])) })); }
      catch (error) { response.destroy(); reject(error); }
    });
    request.on('error', reject);
    request.end(body);
  });
}
