import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONFIG_FILE = fileURLToPath(new URL('../config.json', import.meta.url));
export async function loadConfig(file = process.env.COMPANION_DSH_CONFIG_FILE || DEFAULT_CONFIG_FILE) {
  try {
    if (!isAbsolute(file)) throw new Error();
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    let value;
    try {
      if (!(await handle.stat()).isFile()) throw new Error();
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16384) throw new Error();
      value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally { await handle.close(); }
    const keys = ['socketPath', 'tokenFile', 'actorId'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...keys, 'deliveryFile'].includes(key))) throw new Error();
    if (value.deliveryFile !== undefined && (typeof value.deliveryFile !== 'string' || !isAbsolute(value.deliveryFile) || value.deliveryFile.length > 4096 || value.deliveryFile.includes('\0'))) throw new Error();
    const id = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
    if (!id(value.actorId) || value.actorId.startsWith('dsh:')) throw new Error();
    for (const key of ['socketPath', 'tokenFile']) {
      if (typeof value[key] !== 'string' || !value[key] || value[key].length > 4096 || value[key].includes('\0')) throw new Error();
      value[key] = resolve(dirname(file), value[key]);
    }
    return Object.freeze(value);
  } catch { throw Object.assign(new Error('INVALID_CONFIG: capability-local config unavailable or invalid'), { code: 'INVALID_CONFIG' }); }
}
