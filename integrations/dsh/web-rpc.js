import http from 'node:http';
import { randomUUID } from 'node:crypto';

// Backend execution transport. Never exposes vendor access credentials to a model.
export async function connectWeb({ origin, token, connectPort }) {
  const publicUrl = new URL(origin);
  if (publicUrl.protocol !== 'http:' || publicUrl.hostname !== '127.0.0.1' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('INVALID_WEB_ACCESS');
  async function request(method, target, body, cookie = '') {
    return new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request({ hostname: '127.0.0.1', port: connectPort || Number(publicUrl.port), method, path: target, agent: false, headers: { host: publicUrl.host, origin: publicUrl.origin, ...(cookie ? { cookie } : {}), ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
        const chunks = []; let length = 0;
        res.on('data', chunk => { length += chunk.length; if (length > 2 * 1024 * 1024) { reject(new Error('WEB_RESPONSE_LIMIT')); res.destroy(); return; } chunks.push(chunk); });
        res.on('error', () => reject(new Error('WEB_TRANSPORT_UNAVAILABLE')));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.setTimeout(10000, () => req.destroy()); req.on('error', () => reject(new Error('WEB_TRANSPORT_UNAVAILABLE'))); req.end(bytes);
    });
  }
  const auth = await request('GET', '/?token=' + encodeURIComponent(token));
  if (auth.status !== 303 || auth.headers.location !== './') throw new Error('WEB_AUTHENTICATION_FAILED');
  const cookie = (auth.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('WEB_AUTHENTICATION_FAILED');
  return async (method, args = {}) => {
    const response = await request('POST', '/api/' + method, { type: 'client-request', rpcId: randomUUID(), method, payload: { args } }, cookie);
    if (response.status !== 200) throw new Error('WEB_RPC_HTTP_FAILED');
    let envelope; try { envelope = JSON.parse(response.body); } catch { throw new Error('WEB_RPC_INVALID_RESPONSE'); }
    if (envelope?.result?.ok !== true) throw new Error('WEB_RPC_REJECTED');
    return envelope.result.value;
  };
}
