#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
function git(args) {
  const result = spawnSync('git', ['-C', root, ...args], { maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('INDEX_REVIEW_UNAVAILABLE');
  return result.stdout;
}
const args = process.argv.includes('--all') ? ['ls-files', '-z'] : ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'];
const names = git(args).toString().split('\0').filter(Boolean);
const rules = [
  ['credential_prefix', /(?:sk[-_][A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['private_key', /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/],
];
const findings = [];
for (const name of names) {
  if (name.startsWith('notes/') || /(?:^|\/)\.env(?:$|\.)/.test(name) && !/\.(?:example|sample)$/.test(name) || /\.(?:wav|mp3|m4a|flac|ogg|silk|pcm|pem|key|p12|sqlite|db|gguf|onnx|safetensors|bundle|jsonl|ndjson|har)$/i.test(name)) {
    findings.push({ file: name, reason: 'private_or_runtime_material' }); continue;
  }
  const size = Number(git(['cat-file', '-s', ':' + name]).toString());
  if (size > 5 * 1024 * 1024) { findings.push({ file: name, reason: 'large_blob' }); continue; }
  const bytes = git(['show', ':' + name]);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  for (const [reason, pattern] of rules) if (pattern.test(text)) findings.push({ file: name, reason });
}
// Report locations/categories only: never reflect a matched credential.
console.log(JSON.stringify({ stagedFilesReviewed: names.length, findings }));
if (findings.length) process.exitCode = 1;
