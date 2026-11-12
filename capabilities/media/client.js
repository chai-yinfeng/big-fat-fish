import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const fail = code => Object.assign(new Error(code), { code });
export function unixJson({ socketPath, route, tokenFile, token, body, timeoutMs = 60000, maxBytes = 65536, signal }) {
  if (!path.isAbsolute(socketPath)) return Promise.reject(fail('CONTENT_TRANSPORT_CONFIG'));
  const payload = Buffer.from(JSON.stringify(body));
  if (payload.length > 13 * 1024 * 1024) return Promise.reject(fail('CONTENT_REQUEST_LIMIT'));
  let credential;
  try { credential = token ?? fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return Promise.reject(fail('CONTENT_CREDENTIAL_UNAVAILABLE')); }
  return new Promise((resolve, reject) => {
    let finished = false;
    const rejectOnce = code => { if (!finished) { finished = true; reject(fail(code)); } };
    const req = http.request({ socketPath, path: route, method: 'POST', agent: false, signal, headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json', 'content-length': payload.length } }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { rejectOnce('CONTENT_RESPONSE_LIMIT'); res.destroy(); } else chunks.push(chunk); });
      res.on('error', () => rejectOnce('CONTENT_TRANSPORT_UNAVAILABLE'));
      res.on('end', () => {
        if (finished) return;
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || value.ok !== true || !Object.hasOwn(value, 'value')) { rejectOnce(res.statusCode === 429 ? (['SPEND_RESTRICTED', 'CONTENT_SPEND_RESTRICTED'].includes(value?.error?.code) ? 'CONTENT_SPEND_RESTRICTED' : 'CONTENT_BUDGET_EXHAUSTED') : res.statusCode === 403 ? 'CONTENT_FORBIDDEN' : 'CONTENT_OPERATION_UNAVAILABLE'); return; }
          finished = true; resolve(value.value);
        } catch { rejectOnce('CONTENT_RESPONSE_INVALID'); }
      });
    });
    const timer = setTimeout(() => { rejectOnce('CONTENT_TIMEOUT'); req.destroy(); }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => rejectOnce('CONTENT_TRANSPORT_UNAVAILABLE'));
    req.end(payload);
  });
}

/** Capability credential goes only to Authority. Scope is computed there, never
 * selected by a model or trusted merely because it appeared in a tool argument. */
export class ContentClient {
  constructor({ socketPath, tokenFile }) {
    if (!path.isAbsolute(socketPath) || !path.isAbsolute(tokenFile)) throw fail('CONTENT_TRANSPORT_CONFIG');
    this.socketPath = socketPath; this.tokenFile = tokenFile;
  }
  call(input, { signal } = {}) {
    if (!input || typeof input.streamId !== 'string' || !Number.isSafeInteger(input.memoryEpoch) || !['ingest', 'transcribe', 'describe', 'synthesize', 'asset', 'attach', 'pending', 'search', 'fetch'].includes(input.action)) return Promise.reject(fail('CONTENT_REQUEST_INVALID'));
    return unixJson({ socketPath: this.socketPath, tokenFile: this.tokenFile, route: '/v1/content', body: input,
      timeoutMs: ['transcribe', 'synthesize'].includes(input.action) ? 300000 : 90000,
      maxBytes: input.action === 'asset' ? 13 * 1024 * 1024 : 65536, signal });
  }
}
export function capabilityGateway({ socketPath, tokenFile }) {
  const call = (route, body) => unixJson({ socketPath, tokenFile, route, body, maxBytes: 65536, timeoutMs: 90000 });
  return { vision: body => call('/v1/vision/describe', body), search: body => call('/v1/web/search', body), fetchPage: body => call('/v1/web/fetch', body),
    // The gateway's usage ledger: how a local run ended (count, units, elapsed time; never text or audio).
    recordUsage: body => unixJson({ socketPath, tokenFile, route: '/v1/usage/record', body, maxBytes: 4096, timeoutMs: 5000 }) };
}
/** The local speech runner with every transcription and synthesis reported through `record` (the usage ledger):
 * outcome, elapsed time including the wait for the serial runner, seconds of audio, characters spoken. Reporting
 * is best effort and never awaited: a ledger that is down neither delays nor fails speech. */
export function meteredSpeech(speech, record, clock = Date.now) {
  const report = body => { try { Promise.resolve(record(body)).catch(() => {}); } catch {} };
  const seconds = ms => Math.round(ms / 100) / 10;
  const timed = async (capability, run, units) => {
    const from = clock(), busyMs = () => Math.max(0, Math.round(clock() - from));
    let result;
    try { result = await run(); } catch (error) { report({ capability, outcome: 'failed', busyMs: busyMs() }); throw error; }
    report({ capability, outcome: 'ok', busyMs: busyMs(), units: units(result) });
    return result;
  };
  return {
    ...speech,
    transcribe: input => timed('speech-asr', () => speech.transcribe(input), result => ({ audioSeconds: seconds(result.durationMs) })),
    synthesize: input => timed('speech-tts', () => speech.synthesize(input), result => ({ chars: [...input.text].length, audioSeconds: seconds(result.durationMs) })),
  };
}
