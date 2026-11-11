import http from 'node:http';
import fs from 'node:fs';

// A single bounded completion, not a second tool loop or arbitrary provider API.
export function completeDiary({ socketPath, tokenFile }) {
  return ({ messages, maxTokens }) => new Promise((resolve, reject) => {
    let token;
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { reject(new Error('MEMORY_GATEWAY_UNAVAILABLE')); return; }
    const body = JSON.stringify({ model: 'deepseek', messages, max_tokens: maxTokens, stream: false });
    const request = http.request({ socketPath, path: '/v1/memory/completions', method: 'POST', agent: false, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) response.destroy(new Error('MEMORY_RESPONSE_LIMIT')); else chunks.push(chunk);
      });
      response.on('error', () => reject(new Error('MEMORY_GATEWAY_UNAVAILABLE')));
      response.on('end', () => {
        // The gateway's spend tier stopped maintenance: not a failure of this request (no provider call was made).
        if (response.statusCode === 429) { reject(Object.assign(new Error('MEMORY_BUDGET_DEFERRED'), { code: 'MEMORY_BUDGET_DEFERRED' })); return; }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || typeof value.choices?.[0]?.message?.content !== 'string') throw new Error();
          resolve({ content: value.choices[0].message.content, usage: { prompt_tokens: value.usage?.prompt_tokens || 0, completion_tokens: value.usage?.completion_tokens || 0 } });
        } catch { reject(new Error('MEMORY_GATEWAY_UNAVAILABLE')); }
      });
    });
    request.setTimeout(90000, () => request.destroy(new Error('MEMORY_GATEWAY_TIMEOUT')));
    request.on('error', () => reject(new Error('MEMORY_GATEWAY_UNAVAILABLE')));
    request.end(body);
  });
}
