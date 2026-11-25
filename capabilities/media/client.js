import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CONTENT_ACTIONS } from '../providers/index.js';

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
    if (!input || typeof input.streamId !== 'string' || !Number.isSafeInteger(input.memoryEpoch) || !CONTENT_ACTIONS.some(row => row.action === input.action)) return Promise.reject(fail('CONTENT_REQUEST_INVALID'));
    return unixJson({ socketPath: this.socketPath, tokenFile: this.tokenFile, route: '/v1/content', body: input,
      timeoutMs: ['transcribe', 'synthesize'].includes(input.action) ? 300000 : 90000,
      maxBytes: input.action === 'asset' ? 13 * 1024 * 1024 : 65536, signal });
  }
}
export function capabilityGateway({ socketPath, tokenFile }) {
  const call = (route, body) => unixJson({ socketPath, tokenFile, route, body, maxBytes: 65536, timeoutMs: 90000 });
  // A page read on the web is its whole text (the gateway's WEB_PAGE_CHARS), so its answer may be larger than the rest.
  return { vision: body => call('/v1/vision/describe', body), search: body => call('/v1/web/search', body), fetchPage: body => unixJson({ socketPath, tokenFile, route: '/v1/web/fetch', body, maxBytes: 512 * 1024, timeoutMs: 90000 }),
    // The gateway's usage ledger: how a local run ended (count, units, elapsed time; never text or audio).
    recordUsage: body => unixJson({ socketPath, tokenFile, route: '/v1/usage/record', body, maxBytes: 4096, timeoutMs: 5000 }),
    // One of today's slots of a local capability that has a daily limit; CONTENT_BUDGET_EXHAUSTED when none is left.
    reserveUsage: body => unixJson({ socketPath, tokenFile, route: '/v1/usage/reserve', body, maxBytes: 4096, timeoutMs: 5000 }),
    // One bounded completion for an activity's own model work (no tools, thinking off; the `activity` spend category).
    summarize: activityCompletion({ socketPath, tokenFile }),
    // A still of a shared video, looked at by the vision model: marked `purpose: 'frame'`, so it takes a slot of the
    // `video-frame` row instead of vision's. Only the video provider calls it; nothing a model sends reaches `purpose`.
    describeFrame: ({ imageBase64, mime, question, signal }) => unixJson({ socketPath, tokenFile, route: '/v1/vision/describe', body: { imageBase64, mime, question, detail: 'low', purpose: 'frame' }, maxBytes: 65536, timeoutMs: 90000, signal }) };
}
/** `({ messages, maxTokens, signal }) -> { content }` through the gateway's /v1/activity/completions. Rejects with
 * CONTENT_SPEND_RESTRICTED when the spend tier refused it (no provider call was made), else CONTENT_OPERATION_UNAVAILABLE. */
export function activityCompletion({ socketPath, tokenFile }) {
  return ({ messages, maxTokens, signal }) => new Promise((resolve, reject) => {
    let token;
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { reject(fail('CONTENT_CREDENTIAL_UNAVAILABLE')); return; }
    const body = JSON.stringify({ model: 'deepseek', messages, max_tokens: maxTokens, stream: false });
    const request = http.request({ socketPath, path: '/v1/activity/completions', method: 'POST', agent: false, signal, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 65536) response.destroy(fail('CONTENT_RESPONSE_LIMIT')); else chunks.push(chunk); });
      response.on('error', () => reject(fail('CONTENT_OPERATION_UNAVAILABLE')));
      response.on('end', () => {
        if (response.statusCode === 429) { reject(fail('CONTENT_SPEND_RESTRICTED')); return; }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || typeof value.choices?.[0]?.message?.content !== 'string') throw new Error();
          resolve({ content: value.choices[0].message.content });
        } catch { reject(fail('CONTENT_OPERATION_UNAVAILABLE')); }
      });
    });
    request.setTimeout(110000, () => request.destroy(fail('CONTENT_TIMEOUT')));
    request.on('error', () => reject(fail('CONTENT_OPERATION_UNAVAILABLE')));
    request.end(body);
  });
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
