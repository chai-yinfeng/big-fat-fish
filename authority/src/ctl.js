#!/usr/bin/env node
/** Operator-only entry. Read request JSON from stdin, never secrets from argv. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const args = process.argv.slice(2);
const actions = { health: ['GET', '/v1/health'], summary: ['GET', '/v1/admin/state'], capability: ['POST', '/v1/admin/capabilities'], actor: ['POST', '/v1/admin/actors'], stream: ['POST', '/v1/admin/streams'], persona: ['POST', '/v1/admin/persona'] };
try {
  if (args.length !== 5 || args[0] !== '--socket' || args[2] !== '--token-file' || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3]) || !Object.hasOwn(actions, args[4])) throw new Error('USAGE');
  const file = args[3];
  if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 4096 || (fs.statSync(file).mode & 0o077) !== 0) throw new Error('CREDENTIAL');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('CREDENTIAL');
  const action = args[4];
  const [method, route] = actions[action];
  let body;
  if (method === 'POST') {
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) { length += chunk.length; if (length > 32768) throw new Error('INPUT_LIMIT'); chunks.push(chunk); }
    body = Buffer.from(JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
  }
  const value = await new Promise((resolve, reject) => {
    const request = http.request({ socketPath: args[1], path: route, method, agent: false, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } }, response => {
      const chunks = []; let length = 0;
      response.on('data', chunk => { length += chunk.length; if (length > 1024 * 1024) { reject(new Error('OUTPUT_LIMIT')); response.destroy(); return; } chunks.push(chunk); });
      response.on('error', () => reject(new Error('TRANSPORT')));
      response.on('end', () => {
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || envelope.ok !== true) throw new Error('REJECTED');
          resolve(envelope.value);
        } catch { reject(new Error('REJECTED')); }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('TIMEOUT')));
    request.on('error', () => reject(new Error('TRANSPORT')));
    request.end(body);
  });
  if (action === 'health') console.log(JSON.stringify(value));
  else if (action === 'summary') console.log(JSON.stringify({ revision: value.revision, personaRevision: value.personaRevision, counts: { facts: value.facts.length, experiences: value.experiences.length, notes: value.notes.length, appraisals: value.appraisals.length, capabilities: value.capabilities.length, actors: value.actors.length, streams: value.streams.length, observations: value.observations.length, receipts: value.receipts.length } }));
  else console.log(JSON.stringify({ ok: true, operation: action, ...(value?.revision === undefined ? {} : { revision: value.revision }), ...(value?.personaRevision === undefined ? {} : { personaRevision: value.personaRevision }) }));
} catch {
  process.stderr.write('Authority operator operation failed. Use --socket PATH --token-file PATH health|summary|capability|actor|stream|persona; POST payload is stdin JSON.\n');
  process.exitCode = 1;
}
