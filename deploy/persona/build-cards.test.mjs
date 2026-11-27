import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseCardFile, validateCard, buildBundle, CardFileError, BUNDLE_KIND } from './build-cards.mjs';

const fence = '```';
const card = ({ front = {}, traits = '留空。', extra = '' } = {}) => [
  '---',
  ...Object.entries({ title: 'MOCK-卡', tags: 'MOCK-甲、MOCK-乙，MOCK-甲', summary: 'MOCK-简介', name: 'MOCK-名', userCallName: '你', ...front }).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`),
  '---', '', '# MOCK 标题（不进卡）', '',
  '## identity', '', '说明文字不进卡', '', `${fence}text`, 'MOCK-身份第一段', 'MOCK-身份第二段', fence, '',
  '## traits', '', traits, '',
  '## speechStyle', '', `${fence}text`, 'MOCK-风格', fence, '',
  '## principles', '', '每行一条', `${fence}text`, 'MOCK-原则一', '', '  MOCK-原则二  ', fence, '',
  '## boundaries', '', `${fence}text`, 'MOCK-边界', fence, '',
  '## examples', '', `${fence}text`, '【难过】（冷：x；热：y）', '对方：MOCK-问一', '她：MOCK-答一', 'MOCK-答一续', '', '对方: MOCK-问二', '她: MOCK-答二', fence, '',
  '## 备注', '', '### identity', `${fence}text`, '不会被读到', fence, extra].join('\n');

test('a card file: front matter and the fenced block of each persona section; notes and 【】 titles stay out', () => {
  assert.deepEqual(parseCardFile(card(), 'mock.md'), {
    title: 'MOCK-卡', tags: ['MOCK-甲', 'MOCK-乙'], summary: 'MOCK-简介',
    persona: { name: 'MOCK-名', userCallName: '你', identity: 'MOCK-身份第一段\nMOCK-身份第二段', traits: [], speechStyle: 'MOCK-风格', principles: ['MOCK-原则一', 'MOCK-原则二'], boundaries: ['MOCK-边界'],
      examples: [{ user: 'MOCK-问一', assistant: 'MOCK-答一\nMOCK-答一续' }, { user: 'MOCK-问二', assistant: 'MOCK-答二' }] } });
  assert.deepEqual(parseCardFile(card({ traits: `${fence}text\nMOCK-特质\n${fence}`, front: { tags: undefined, summary: undefined } }), 'mock.md').persona.traits, ['MOCK-特质']);
  assert.deepEqual(parseCardFile(card({ front: { tags: undefined, summary: undefined } }), 'mock.md').summary, '');
});

test('a malformed card file names the file, the field and the rule', () => {
  const fails = (source, field) => assert.throws(() => parseCardFile(source, 'mock.md'), error => error instanceof CardFileError && error.file === 'mock.md' && error.field === field && error.message.startsWith('mock.md: '));
  fails('# no front matter', 'file');
  fails(card({ front: { title: '' } }), 'title');
  fails(card({ front: { userCallName: undefined } }), 'userCallName');
  fails(card({ front: { mood: 'x' } }), 'mood');
  fails(card().replace('## speechStyle', '## speechstyle'), 'speechStyle');
  fails(card().replace('## boundaries', '## 边界'), 'boundaries');
  fails(card().replace('她：MOCK-答一', 'MOCK-没有前缀'), 'examples');
  fails(card().replace('对方: MOCK-问二', '她：MOCK-多一句'), 'examples');
  fails(card({ traits: `${fence}text\nMOCK-特质` }), 'traits');
});

test('the card limits of Authority are checked per field before anything is written', () => {
  const rule = (front, field, words) => {
    const parsed = parseCardFile(card({ front }), 'mock.md');
    assert.throws(() => validateCard(parsed, 'mock.md'), error => error.field === field && error.rule.includes(words), field);
  };
  rule({ title: 'x'.repeat(41) }, 'title', '最多 40 字');
  rule({ tags: '1 2 3 4 5 6 7' }, 'tags', '最多 6 个');
  rule({ tags: `MOCK ${'x'.repeat(13)}` }, 'tags', '第 2 个标签');
  rule({ summary: 'x'.repeat(61) }, 'summary', '最多 60 字');
  const long = parseCardFile(card(), 'mock.md'); long.persona.identity = 'x'.repeat(4001);
  assert.throws(() => validateCard(long, 'mock.md'), error => error.field === 'identity' && error.rule === '最多 4000 字');
  validateCard(parseCardFile(card(), 'mock.md'), 'mock.md');
});

test('a directory becomes one bundle; README, _ files and a duplicate title are handled; the CLI writes only when every card passes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-cards-'));
  try {
    await writeFile(join(dir, 'b.md'), card({ front: { title: 'MOCK-乙' } }));
    await writeFile(join(dir, 'a.md'), card({ front: { title: 'MOCK-甲' } }));
    await writeFile(join(dir, 'README.md'), 'not a card');
    await writeFile(join(dir, '_draft.md'), 'not a card');
    const { bundle, report } = await buildBundle(dir);
    assert.deepEqual([bundle.kind, bundle.version, bundle.cards.map(item => item.title), report.map(row => row.file)], [BUNDLE_KIND, 1, ['MOCK-甲', 'MOCK-乙'], ['a.md', 'b.md']]);
    const run = promisify(execFile), cli = new URL('./build-cards.mjs', import.meta.url).pathname, out = join(dir, 'out.json');
    const { stdout } = await run(process.execPath, [cli, dir, '--out', out]);
    assert.ok(stdout.includes('2 张卡已写入'));
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), bundle);
    await writeFile(join(dir, 'c.md'), card({ front: { title: 'MOCK-甲' } }));
    await assert.rejects(buildBundle(dir), error => error.file === 'c.md' && error.field === 'title' && error.rule.includes('a.md'));
    await rm(out);
    await assert.rejects(run(process.execPath, [cli, dir, '--out', out]), error => error.code === 1 && error.stderr.includes('c.md: title'));
    await assert.rejects(readFile(out), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
