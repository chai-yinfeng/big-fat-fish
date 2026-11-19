import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AuthorityClient } from '../authority/src/client.js';
import { createModelGateway } from './server.mjs';
import { createProxyFetch } from './proxy-fetch.mjs';
import { load } from './config.mjs';

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--config') throw new Error('Expected --config');
  // Checks and unknown keys: model-gateway/config.mjs (unknown keys are ignored with one stderr line).
  const config = await load(args[1]);
  const authority = new AuthorityClient(config.authority);
  // The host's outbound HTTP proxy for the provider adapters that declare `proxy: true` (not a secret; set in the unit).
  const proxy = process.env.COMPANION_OUTBOUND_PROXY;
  const gateway = createModelGateway({ ...config, worldStatus: async () => (await authority.health()).world, ...(proxy ? { proxyFetch: createProxyFetch(proxy) } : {}) });
  await gateway.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await gateway.close(); } catch { process.exitCode = 1; }
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return gateway;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Model gateway failed\n'); process.exitCode = 1; });
}
