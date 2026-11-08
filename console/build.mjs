import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');
// Standalone page only; `--standalone` is accepted for existing callers.
{
  const { build } = await import('esbuild');
  await mkdir(new URL('dist/', root), { recursive: true });
  const runtimeLicense = await read('node_modules/react/LICENSE');
  await build({ banner: { js: `/*! React / React DOM / Scheduler\n${runtimeLicense}\n*/` }, absWorkingDir: fileURLToPath(root), entryPoints: ['standalone-entry.js'], outfile: 'dist/console.js', bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true, sourcemap: false, legalComments: 'inline', define: { 'process.env.NODE_ENV': '"production"' } });
  await copyFile(new URL('index.html', root), new URL('dist/index.html', root));
  await copyFile(new URL('icon.svg', root), new URL('dist/icon.svg', root));
}
