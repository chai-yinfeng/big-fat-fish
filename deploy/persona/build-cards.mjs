#!/usr/bin/env node
// Persona card files (Markdown, one card per file) -> the card bundle the console's 「导入卡包」 accepts.
// Runs on the Mac only; it reads files and writes one JSON file, and talks to no service.
// The card file format is specified in deploy/persona/README.md.
//
//   node deploy/persona/build-cards.mjs <card directory> [--out <bundle.json>]
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePersonaPatch } from '../../authority/src/persona.js';
import { personaContextText, PERSONA_CHARS } from '../../authority/src/context.js';
import { MAX_PERSONA_CARDS, CARD_TITLE_CHARS, CARD_TAGS, CARD_TAG_CHARS, CARD_SUMMARY_CHARS } from '../../authority/src/cards.js';

export const BUNDLE_KIND = 'big-fat-fish/persona-cards';
export const BUNDLE_VERSION = 1;
const FRONT_KEYS = ['title', 'tags', 'summary', 'name', 'userCallName'];
const REQUIRED_FRONT = ['title', 'name', 'userCallName'];
const TEXT_SECTIONS = ['identity', 'speechStyle'];
const LIST_SECTIONS = ['traits', 'principles', 'boundaries'];
const SECTIONS = [...TEXT_SECTIONS, ...LIST_SECTIONS, 'examples'];
const REQUIRED_SECTIONS = ['identity', 'speechStyle', 'principles', 'boundaries', 'examples'];
const FIELD_NAMES = { title: '卡名称', tags: '标签', summary: '简介', name: '名字', userCallName: '对用户的称呼', identity: '身份', traits: '特质', speechStyle: '说话风格', principles: '原则', boundaries: '边界', examples: '对话示例', persona: '人格整体', file: '文件' };

/** An error that says which card, which field and which rule; never more of the content than a line number. */
export class CardFileError extends Error {
  constructor(file, field, rule) {
    super(`${file}: ${field}（${FIELD_NAMES[field] ?? field}）: ${rule}`);
    Object.assign(this, { file, field, rule });
  }
}

/** Tags typed on one line, separated by 、 , ， ; ； or spaces (the same rule as the console's tag input). */
export function splitTags(line) {
  return [...new Set(String(line || '').split(/[,，、;；\s]+/).map(tag => tag.trim()).filter(Boolean))];
}

// The only fenced block of a section (```text or plain ```); text around it is notes and is ignored.
function fenced(lines, fail) {
  const opens = lines.map((line, index) => /^```/.test(line.trim()) ? index : -1).filter(index => index >= 0);
  if (!opens.length) return '';
  if (opens.length !== 2) fail('只能有一个 ``` 代码块，并且要成对闭合');
  return lines.slice(opens[0] + 1, opens[1]).join('\n');
}

function examples(block, fail) {
  const pairs = [];
  let side = null;
  for (const [index, raw] of block.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('【')) { side = null; continue; }
    const user = line.match(/^对方[：:]\s*(.*)$/), assistant = line.match(/^她[：:]\s*(.*)$/);
    if (user) {
      if (pairs.length && pairs.at(-1).assistant === undefined) fail(`代码块第 ${index + 1} 行：上一组还没有「她：」`);
      pairs.push({ user: user[1] }); side = 'user';
    } else if (assistant) {
      if (!pairs.length || pairs.at(-1).assistant !== undefined) fail(`代码块第 ${index + 1} 行：「她：」前面要先有「对方：」`);
      pairs.at(-1).assistant = assistant[1]; side = 'assistant';
    } else if (side) {
      pairs.at(-1)[side] += `\n${line}`;
    } else fail(`代码块第 ${index + 1} 行：每组以「对方：」开头、「她：」接着，【】开头的行是标题`);
  }
  if (pairs.length && pairs.at(-1).assistant === undefined) fail('最后一组缺少「她：」');
  return pairs.map(({ user, assistant }) => ({ user: user.trim(), assistant: assistant.trim() }));
}

/** One card file -> { title, tags, summary, persona }. Throws CardFileError. */
export function parseCardFile(source, file = 'card.md') {
  const lines = String(source).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') throw new CardFileError(file, 'file', '第一行必须是 ---，开始卡片信息');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new CardFileError(file, 'file', '卡片信息缺少结尾的 ---');
  const front = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z]+)\s*[:：]\s?(.*)$/);
    if (!match) throw new CardFileError(file, 'file', `卡片信息每行写成「字段: 值」，这一行不是：${line.slice(0, 20)}`);
    const [, key, value] = match;
    if (!FRONT_KEYS.includes(key)) throw new CardFileError(file, key, `不认识的字段，只能是 ${FRONT_KEYS.join('、')}`);
    if (Object.hasOwn(front, key)) throw new CardFileError(file, key, '写了两次');
    front[key] = value.trim();
  }
  for (const key of REQUIRED_FRONT) if (!front[key]) throw new CardFileError(file, key, '必填，不能为空');
  const sections = {};
  let open = null;
  for (const line of lines.slice(end + 1)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const name = heading[1];
      const near = SECTIONS.find(key => key.toLowerCase() === name.toLowerCase());
      if (near && near !== name) throw new CardFileError(file, near, `小节标题要写成「## ${near}」（大小写一致）`);
      if (near && sections[near]) throw new CardFileError(file, near, '小节写了两次');
      open = near ?? null;
      if (open) sections[open] = [];
      continue;
    }
    if (open) sections[open].push(line);
  }
  for (const key of REQUIRED_SECTIONS) if (!sections[key]) throw new CardFileError(file, key, `缺少「## ${key}」小节`);
  const persona = { name: front.name, userCallName: front.userCallName };
  for (const key of SECTIONS) {
    const block = fenced(sections[key] ?? [], rule => { throw new CardFileError(file, key, rule); });
    if (TEXT_SECTIONS.includes(key)) persona[key] = block.trim();
    else if (LIST_SECTIONS.includes(key)) persona[key] = block.split('\n').map(item => item.trim()).filter(Boolean);
    else persona.examples = examples(block, rule => { throw new CardFileError(file, key, rule); });
  }
  return { title: front.title, tags: splitTags(front.tags), summary: front.summary ?? '', persona };
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
/** The limits Authority enforces (authority/src/cards.js and persona.js), checked per card before anything is written. */
export function validateCard(card, file) {
  const fail = (field, rule) => { throw new CardFileError(file, field, rule); };
  if (card.title.length > CARD_TITLE_CHARS) fail('title', `最多 ${CARD_TITLE_CHARS} 字，现在 ${card.title.length} 字`);
  if (CONTROL.test(card.title)) fail('title', '不能含控制字符');
  if (card.tags.length > CARD_TAGS) fail('tags', `最多 ${CARD_TAGS} 个，现在 ${card.tags.length} 个`);
  card.tags.forEach((tag, index) => { if (tag.length > CARD_TAG_CHARS) fail('tags', `第 ${index + 1} 个标签「${tag}」最多 ${CARD_TAG_CHARS} 字，现在 ${tag.length} 字`); });
  if (card.summary.length > CARD_SUMMARY_CHARS) fail('summary', `最多 ${CARD_SUMMARY_CHARS} 字，现在 ${card.summary.length} 字`);
  if (CONTROL.test(card.summary)) fail('summary', '不能含控制字符');
  try { validatePersonaPatch(card.persona); }
  catch (error) {
    const { field = 'persona', rule = 'invalid', limit } = error.detail ?? {};
    fail(field, { maxChars: `最多 ${limit} 字`, maxItems: `最多 ${limit} 条`, required: '不能为空', invalid: '格式不对' }[rule] ?? rule);
  }
}

/** Every *.md in a directory except README.md and names starting with _ or . -> a validated bundle. */
export async function buildBundle(directory) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.md') && name !== 'README.md' && !/^[_.]/.test(name)).sort();
  if (!names.length) throw new CardFileError(basename(directory), 'file', '目录里没有卡文件（*.md，README.md 和 _ 开头的除外）');
  if (names.length > MAX_PERSONA_CARDS) throw new CardFileError(basename(directory), 'file', `最多 ${MAX_PERSONA_CARDS} 张卡，现在 ${names.length} 个文件`);
  const cards = [], seen = new Map(), report = [];
  for (const name of names) {
    const card = parseCardFile(await readFile(join(directory, name), 'utf8'), name);
    validateCard(card, name);
    if (seen.has(card.title)) throw new CardFileError(name, 'title', `和 ${seen.get(card.title)} 的卡名称重复：卡库按卡名称匹配，名称必须唯一`);
    seen.set(card.title, name);
    cards.push(card);
    report.push({ file: name, title: card.title, chars: personaContextText({ relationshipStage: 'new', ...card.persona }).length });
  }
  return { bundle: { kind: BUNDLE_KIND, version: BUNDLE_VERSION, cards }, report };
}

async function main(argv) {
  const args = [...argv], outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
  if (args.length !== 1 || (outAt >= 0 && !out)) {
    console.error('用法: node deploy/persona/build-cards.mjs <卡文件目录> [--out <输出.json>]');
    return 2;
  }
  const directory = resolve(args[0]), target = resolve(out ?? join(directory, 'persona-cards.json'));
  try {
    const { bundle, report } = await buildBundle(directory);
    for (const row of report) console.log(`ok  ${row.file}  「${row.title}」  人格块 ${row.chars} / ${PERSONA_CHARS} 字${row.chars > PERSONA_CHARS ? '  ！超出预算，末尾会被截断' : ''}`);
    await writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`);
    console.log(`\n${bundle.cards.length} 张卡已写入 ${target}\n下一步：控制台「人格」页 → 人格卡库 →「导入卡包」，选这个文件，看过差异后确认。`);
    return 0;
  } catch (error) {
    if (!(error instanceof CardFileError)) throw error;
    console.error(`校验失败，没有写出文件：\n  ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
