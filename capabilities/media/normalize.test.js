import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import { createNormalizeImage } from './normalize.js';

/** A PNG made here of `width` x `height` (header only matters to the check; never a real picture). */
function png(width, height) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3]))), chunk('IEND', Buffer.alloc(0))]);
}
const missing = '/nonexistent/companion-test/node_modules/sharp';
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

test('no image runtime: a picture fails, unless the staging-only switch lets a small PNG through as it is', async () => {
  // Default (production): missing runtime fails for every picture, a small PNG included.
  for (const options of [{}, { allowRawSmallPng: false }, { allowRawSmallPng: 'true' }]) await assert.rejects(createNormalizeImage({ sharpModule: missing, ...options })(png(1, 1)), { code: 'MODULE_NOT_FOUND' }, JSON.stringify(options));
  const open = createNormalizeImage({ sharpModule: missing, allowRawSmallPng: true });
  const small = png(512, 512);
  assert.deepEqual(await open(small), { data: small, mime: 'image/png' });
  for (const data of [png(513, 1), png(1, 513), GIF, Buffer.concat([png(1, 1), Buffer.alloc(1048576)]), Buffer.from([137, 80, 78, 71])]) await assert.rejects(open(data), { code: 'MODULE_NOT_FOUND' });
  // A runtime that is installed but broken in another way is never bypassed.
  const broken = createNormalizeImage({ sharpModule: missing, allowRawSmallPng: true, load: () => { throw Object.assign(new Error('bad'), { code: 'ERR_DLOPEN_FAILED' }); } });
  await assert.rejects(broken(png(1, 1)), { code: 'ERR_DLOPEN_FAILED' });
  // With the runtime the picture is re-encoded as before.
  const calls = [], fake = data => { calls.push(data); const chain = { rotate: () => chain, resize: () => chain, flatten: () => chain, jpeg: () => chain, toBuffer: async () => Buffer.from('MOCK-JPEG') }; return chain; };
  assert.deepEqual(await createNormalizeImage({ sharpModule: missing, allowRawSmallPng: true, load: () => fake })(small), { data: Buffer.from('MOCK-JPEG'), mime: 'image/jpeg' });
  assert.equal(calls.length, 1);
});
