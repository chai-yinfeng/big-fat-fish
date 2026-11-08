// Test-only loader: evaluates the shared view with an injected fake React in a vm
// context, so UI tests need neither a DOM nor the bundled React runtime.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const stripModule = source => source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');

/** Returns { factory(require) -> { WorldConsole, flattenDictionary } } evaluated in `context`. */
export async function loadConsole(context) {
  const dictionaries = Object.fromEntries(await Promise.all(['en', 'zh'].map(async locale => [locale, JSON.parse(await read(`locale/${locale}.json`))])));
  const source = `(function factory(require) {\nconst React = require('react');\nconst DICTIONARIES = ${JSON.stringify(dictionaries)};\n${stripModule(await read('operator-client.js') + '\n' + await read('runtime-client.js'))}\n${stripModule(await read('view.js'))}\nreturn { WorldConsole, flattenDictionary };\n})`;
  return { factory: vm.runInNewContext(source, context) };
}
