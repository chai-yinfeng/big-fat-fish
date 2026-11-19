#!/usr/bin/env node
// Staging and test stand-in for ffmpeg (capabilities/providers/video): answers the fixed command lines the video
// provider builds, without decoding anything. Never part of a release.
//   node fake-ffmpeg.mjs <the provider's ffmpeg arguments>
// - Audio pieces (`… -f segment … piece-%04d.wav`): two pieces, each a copy of the input.
// - Scene cuts (`… -vf select=gt(scene…),metadata=print:file=scenes.txt -f null -`): the input must be the stand-in
//   video fake-ytdlp.mjs writes; cuts at 10, 50 and 60 seconds go to scenes.txt (a 95-second MOCK video: shots of 10,
//   40, 10 and 35 seconds). MOCKONETAKE has no cut.
// - A still (`-ss <t> … <name>.jpg … <name>.gray`): a tiny JPEG and 64 grey bytes whose pattern depends on the shot
//   <t> falls in. The fourth shot looks the same as the second (a cutaway and back): its hash is a near-duplicate.
// It keeps no log.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MOCK_CUTS = Object.freeze([10, 50, 60]);
// A 1x1 white baseline JPEG.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
/** Grey 8x8 pictures: three different ones, the fourth shot repeats the second with one pixel changed. */
const PATTERNS = [index => index < 32 ? 20 : 230, index => (index + Math.floor(index / 8)) % 2 ? 20 : 230, index => index % 8 < 4 ? 230 : 20];
const grey = shot => Buffer.from(Array.from({ length: 64 }, (_, index) => shot === 3 ? (index === 0 ? 120 : PATTERNS[1](index)) : PATTERNS[shot](index)));

const args = process.argv.slice(2);
const refuse = line => { process.stderr.write(`MOCK-FFMPEG ${line}\n`); process.exit(2); };
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!args.includes('-nostdin')) refuse('missing -nostdin');
  const input = args[args.indexOf('-i') + 1];
  if (args.at(-1) === 'piece-%04d.wav') {
    if (fs.readFileSync(input).length < 44) process.exit(3);
    for (const n of [0, 1]) fs.copyFileSync(input, 'piece-000' + n + '.wav');
    process.exit(0);
  }
  let video;
  try { video = JSON.parse(fs.readFileSync(input, 'utf8')); } catch { refuse('not a MOCK video'); }
  if (video?.mock !== 'video') refuse('not a MOCK video');
  const cuts = String(video.id).startsWith('MOCKONETAKE') ? [] : MOCK_CUTS;
  const filter = args[args.indexOf('-vf') + 1] ?? '';
  if (/^select=gt\(scene\\,0\.\d+\),metadata=print:file=scenes\.txt$/.test(filter) && args.at(-1) === '-') {
    fs.writeFileSync('scenes.txt', cuts.map((time, n) => `frame:${n}    pts:${time * 12800}  pts_time:${time}\nlavfi.scene_score=0.800000\n`).join(''));
  } else if (args.includes('-ss') && args.at(-1).endsWith('.gray')) {
    const time = Number(args[args.indexOf('-ss') + 1]), name = args.at(-1).slice(0, -5);
    if (!Number.isFinite(time) || time < 0 || time >= video.duration || args.filter(arg => arg === '-frames:v').length !== 2 || !args.includes(name + '.jpg')) refuse('unexpected still options');
    const shot = cuts.filter(cut => cut <= time).length;
    fs.writeFileSync(name + '.jpg', JPEG); fs.writeFileSync(name + '.gray', grey(shot % 4));
  } else refuse('unsupported command');
}
