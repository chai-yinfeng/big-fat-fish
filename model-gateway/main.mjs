import fs from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AuthorityClient } from '../authority/src/client.js';
import { createModelGateway } from './server.mjs';
import { createProxyFetch } from './proxy-fetch.mjs';

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--config') throw new Error('Expected --config');
  const handle = await fs.open(args[1], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let config;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 32768) throw new Error('Unsafe gateway launch configuration');
    config = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  const keys = ['settingsFile', 'inferenceSocket', 'controlSocket', 'inferenceTokenHash', 'operatorTokenHash', 'authority', 'usageFile', 'budgets'];
  if (!config || Object.keys(config).some(key => !keys.includes(key)) || !config.authority || Object.keys(config.authority).some(key => !['socketPath', 'tokenFile'].includes(key))) throw new Error('Invalid gateway launch configuration');
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
