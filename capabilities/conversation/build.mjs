#!/usr/bin/env node
// Bundle the conversation executor service into one ESM file (no node_modules in a release).
// Usage: node capabilities/conversation/build.mjs <outfile>
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.resolve(process.argv[2] || path.join(here, 'dist/conversation.mjs'));
const { build } = await import('esbuild');
await build({
  absWorkingDir: here, entryPoints: ['main.mjs'], outfile, bundle: true, format: 'esm', platform: 'node', target: ['node24'],
  minify: false, sourcemap: false, legalComments: 'inline', logLevel: 'warning',
  // Bundled CommonJS dependencies (openai etc.) may call require for Node built-ins.
  banner: { js: "import { createRequire as __companionCreateRequire } from 'node:module'; const require = __companionCreateRequire(import.meta.url);" },
});
process.stdout.write(JSON.stringify({ outfile }) + '\n');
