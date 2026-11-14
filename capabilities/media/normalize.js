import { createRequire } from 'node:module';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** A PNG of at most 512x512 and 1 MiB: what the shrinking step would leave as it is. */
const smallPng = data => data.length >= 24 && data.length <= 1048576 && data.subarray(0, 8).equals(PNG) && data.subarray(12, 16).toString('ascii') === 'IHDR' && data.readUInt32BE(16) <= 512 && data.readUInt32BE(20) <= 512;

/** Pictures for the vision provider: re-encoded by the image runtime (sharp) to a JPEG of at most 512x512, first frame
 * only. No runtime: fails, unless `allowRawSmallPng` (content.json, written only by the staging fixtures, never by the
 * production setup) lets a small PNG through as it is. */
export function createNormalizeImage({ sharpModule, allowRawSmallPng = false, load = createRequire(import.meta.url) }) {
  let sharp;
  return async data => {
    try { sharp ||= load(sharpModule); }
    catch (error) { if (allowRawSmallPng === true && error?.code === 'MODULE_NOT_FOUND' && smallPng(data)) return { data, mime: 'image/png' }; throw error; }
    const image = await sharp(data, { limitInputPixels: 40000000, animated: false, page: 0, pages: 1 }).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
    return { data: image, mime: 'image/jpeg' };
  };
}
