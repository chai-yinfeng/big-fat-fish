#!/usr/bin/env node
// Prints, as one JSON line, the configuration keys this release reads in each operator file that has a config module
// (KEYS of model-gateway/config.mjs, capabilities/*/config.js, authority/src/config.js): key names and the release's
// package version only, never a value. A nested key a module declares is listed as `parent.child`. Staging reads this
// to decide whether a release knows a key before writing it; releases without this script are searched as source.
//   node ops/config-keys.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Release: ops/ sits next to capabilities/; checkout: deploy/authority/.
const tree = fs.existsSync(path.join(here, '../capabilities')) ? path.resolve(here, '..') : path.resolve(here, '../..');

/** Operator file (relative to operator/) -> its config module. */
export const MODULES = Object.freeze({
  'authority.json': 'authority/src/config.js',
  'content.json': 'capabilities/media/config.js',
  'memory-worker.json': 'capabilities/memory/config.js',
  'model-gateway.json': 'model-gateway/config.mjs',
  'providers/video.json': 'capabilities/providers/video/config.js',
  'qq-bridge.json': 'capabilities/qq/config.js',
});

export async function configKeys() {
  const files = {};
  for (const [label, module] of Object.entries(MODULES)) {
    const { KEYS } = await import(pathToFileURL(path.join(tree, module)).href);
    files[label] = Object.entries(KEYS).flatMap(([key, spec]) => [key, ...(spec.keys ?? []).map(inner => `${key}.${inner}`)]);
  }
  return { version: JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8')).version, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(await configKeys()) + '\n');
}
