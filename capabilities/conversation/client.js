import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const fail = code => Object.assign(new Error(code), { code });

/** Channel-side client of the private conversation service (UDS + bearer). */
export function createConversationClient({ socketPath, tokenFile }) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || typeof tokenFile !== 'string' || !path.isAbsolute(tokenFile)) throw fail('CONVERSATION_CLIENT_CONFIG');
  return {
    execute(request) {
      let token;
      try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return Promise.reject(fail('CONVERSATION_CREDENTIAL_UNAVAILABLE')); }
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return Promise.reject(fail('CONVERSATION_CREDENTIAL_UNAVAILABLE'));
      const body = Buffer.from(JSON.stringify(request));
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
        const req = http.request({ socketPath, path: '/execute', method: 'POST', agent: false, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': body.length } }, res => {
          const chunks = []; let size = 0;
          res.on('data', chunk => { size += chunk.length; if (size > 256 * 1024) { finish(fail('CONVERSATION_RESPONSE_LIMIT')); res.destroy(); } else chunks.push(chunk); });
          res.on('error', () => finish(fail('CONVERSATION_UNAVAILABLE')));
          res.on('end', () => {
            let envelope;
            try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { finish(fail('CONVERSATION_RESPONSE_INVALID')); return; }
            if (res.statusCode === 200 && envelope?.ok === true && typeof envelope.value?.text === 'string') finish(null, envelope.value.text);
            else finish(fail(typeof envelope?.error?.code === 'string' && /^[A-Z_]{1,64}$/.test(envelope.error.code) ? envelope.error.code : 'CONVERSATION_FAILED'));
          });
        });
        // The service enforces timeoutMs itself; this only bounds a lost service.
        const timer = setTimeout(() => { finish(fail('EXECUTION_TIMEOUT')); req.destroy(); }, (Number.isSafeInteger(request?.timeoutMs) ? request.timeoutMs : 0) + 10000);
        req.on('error', () => finish(fail('CONVERSATION_UNAVAILABLE')));
        req.end(body);
      });
    },
  };
}
