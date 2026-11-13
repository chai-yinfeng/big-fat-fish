import http from 'node:http';
import path from 'node:path';

// This socket is mounted to the human control plane, never to model workers.
export function createModelControlClient(socketPath, routes = ['/model', '/model/test', '/cancel', '/spend', '/spend/settings', '/usage', '/usage/history', '/usage/limits', '/providers', '/providers/key', '/providers/clear']) {
  if (!path.isAbsolute(socketPath)) throw new Error('MODEL_CONTROL_CONFIG');
  return (route, body, authorization) => new Promise((resolve, reject) => {
    // `/usage/history` alone carries a query (`?days=N`, built by the operator server from a checked integer).
    if (!routes.includes(route.startsWith('/usage/history?') ? '/usage/history' : route)) return reject(new Error('MODEL_CONTROL_ROUTE'));
    const fail = () => reject(Object.assign(new Error('Model service unavailable'), { code: 'MODEL_UNAVAILABLE', statusCode: 503 }));
    const req = http.request({ socketPath, path: route, method: body === undefined ? 'GET' : 'POST', agent: false,
      headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, res => {
      let raw = '', size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > (route.startsWith('/usage/history') ? 262144 : 16384)) { res.destroy(); fail(); } else raw += chunk; });
      res.on('error', fail);
      res.on('end', () => {
        try {
          const envelope = JSON.parse(raw);
          if (res.statusCode !== 200 || envelope.ok !== true) return reject(Object.assign(new Error('Model operation failed'), { statusCode: [400, 409, 503].includes(res.statusCode) ? res.statusCode : 503, code: res.statusCode === 409 ? 'CONFLICT' : 'MODEL_UNAVAILABLE' }));
          resolve(envelope.value);
        } catch { fail(); }
      });
    });
    req.setTimeout(route === '/model/test' ? 60000 : 10000, () => { req.destroy(); fail(); });
    req.on('error', fail); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
