import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Host-only control credential. Neither this socket nor its token is mounted
// into the model worker; capability content requests still require Core scope.
function contentRequest({ socketPath, tokenFile }, route, payload, { signal } = {}) {
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(tokenFile)) throw new Error('CONTENT_CONTROL_CONFIG');
  return new Promise((resolve, reject) => {
    const unavailable = () => reject(Object.assign(new Error('Content service unavailable'), { code: 'UNAVAILABLE', statusCode: 503 }));
    let token; try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { unavailable(); return; }
    const req = http.request({ socketPath, path: route, method: 'POST', agent: false, signal,
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 13 * 1024 * 1024) { res.destroy(); unavailable(); } else chunks.push(chunk); });
      res.on('error', unavailable);
      res.on('end', () => {
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || envelope.ok !== true) {
            if (route === '/operator' && [400, 409, 413, 503].includes(res.statusCode)) {
              reject(Object.assign(new Error('Content operator operation failed'), { code: 'CONTENT_OPERATOR_FAILED', statusCode: res.statusCode })); return;
            }
            // The gateway's spend tier stopped vision/web: the channel may stay silent instead of apologizing.
            if (route === '/content' && res.statusCode === 429 && envelope?.error?.code === 'CONTENT_SPEND_RESTRICTED') {
              reject(Object.assign(new Error('Content capability stopped by the spend cap'), { code: 'SPEND_RESTRICTED', statusCode: 429 })); return;
            }
            unavailable(); return;
          }
          resolve(envelope.value);
        } catch { unavailable(); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); unavailable(); }, 310000);
    req.on('close', () => clearTimeout(timer)); req.on('error', unavailable);
    req.end(JSON.stringify(payload));
  });
}
export function createContentControlClient(config) {
  return (scope, input) => contentRequest(config, '/content', { scope, input });
}
export function createContentOperatorClient(config) {
  return (action, input = {}, options = {}) => contentRequest(config, '/operator', { ...input, action }, options);
}
