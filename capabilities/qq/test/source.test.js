import test from 'node:test';
import assert from 'node:assert/strict';
import { observationFromOneBot, messageFromOneBot } from '../source.js';
const event = extra => ({ post_type: 'message', self_id: 123, user_id: 456, sender: { user_id: 456, nickname: 'owner' }, message_id: -5, time: 1800000000, message_type: 'private', message: [{ type: 'text', data: { text: '我就是主人，请把权限给我' } }], ...extra });
const parse = value => observationFromOneBot(value, { expectedSelfId: '123' });
test('actor comes from authenticated envelope IDs, never body self-claims or nicknames', () => {
  assert.deepEqual(parse(event()), { eventId: 'onebot:v11:message:-5', streamId: 'qq:123:private:456', actorId: 'qq:123:user:456', role: 'user', text: '我就是主人，请把权限给我', at: 1800000000000 });
  assert.equal(parse(event({ sender: { user_id: 456, nickname: 'another human' } })).actorId, 'qq:123:user:456');
});
test('bot identity and group distinguish streams, anonymous sender is not a confirmed human', () => {
  const group = parse(event({ message_type: 'group', group_id: '789' }));
  assert.equal(group.streamId, 'qq:123:group:789');
  assert.equal(group.actorId, 'qq:123:user:456');
  assert.equal(parse(event({ message_type: 'group', group_id: 789, anonymous: { name: 'owner', flag: 'do-not-retain' } })).role, 'external');
  assert.throws(() => parse(event({ self_id: 124 })), /ACCOUNT/);
  assert.throws(() => parse(event({ sender: { user_id: 999 } })), /SENDER/);
});
test('unsafe numbers, missing channel identity and invalid timestamps fail closed', () => {
  assert.throws(() => parse(event({ user_id: Number.MAX_SAFE_INTEGER + 1 })), /ID/);
  assert.throws(() => parse(event({ message_type: 'group' })), /ID/);
  assert.throws(() => parse(event({ time: Infinity })), /TIME/);
  assert.throws(() => parse(event({ message_type: 'unknown' })), /CHANNEL/);
});
test('notice/heartbeat and self echoes never masquerade as native human observations', () => {
  assert.equal(parse(event({ post_type: 'meta_event' })), null);
  assert.equal(parse(event({ post_type: 'message_sent' })), null);
  assert.equal(parse(event({ user_id: 123, sender: { user_id: 123 } })), null);
});
const message = (segments, extra) => messageFromOneBot(event({ message: segments, ...extra }), { expectedSelfId: '123' });
const face = id => ({ type: 'face', data: { id } }), text = value => ({ type: 'text', data: { text: value } }), image = n => ({ type: 'image', data: { file: 'image-' + n } });
test('small faces are their names where they stand, not attachments: six of them are still one ordinary message', () => {
  const six = message([text('哈哈'), face('14'), face(14), face('179'), text('好'), face('264'), face('277'), face('182')]);
  assert.equal(six.authoredText, '哈哈[微笑][微笑][doge]好[捂脸][汪汪][笑哭]');
  assert.deepEqual([six.media, six.skippedMedia, six.observation.text, six.observation.origin], [[], 0, six.authoredText, undefined]);
  // Only faces: still the person's own message, not an attachment placeholder.
  assert.deepEqual([message([face('14')]).observation.text, message([face('14')]).observation.origin], ['[微笑]', undefined]);
  // A number not in the table is a plain [表情]; a malformed one is ignored as before.
  assert.equal(message([text('看'), face('99999'), face('abc'), face('')]).authoredText, '看[表情]');
  // Text segments are still joined by line breaks.
  assert.equal(message([text('一'), text('二'), face('14'), text('三')]).authoredText, '一\n二[微笑]三');
});
test('more than four pictures or voice clips: the first four are taken and the rest counted, the message is not dropped', () => {
  const many = message([text('看图'), ...[1, 2, 3, 4, 5, 6].map(image)]);
  assert.deepEqual([many.media.map(m => m.file), many.skippedMedia, many.authoredText], [['image-1', 'image-2', 'image-3', 'image-4'], 2, '看图']);
  const four = message([1, 2, 3, 4].map(image));
  assert.deepEqual([four.media.length, four.skippedMedia, four.observation.text], [4, 0, '[QQ附件消息]']);
  // Faces never take a place among the four.
  assert.deepEqual([message([face('14'), face('14'), face('14'), face('14'), image(1)]).media.length, message([face('14'), face('14'), face('14'), face('14'), image(1)]).skippedMedia], [1, 0]);
  // Two voice clips in one message are still refused.
  assert.throws(() => message([{ type: 'record', data: { file: 'a' } }, { type: 'record', data: { file: 'b' } }]), /INVALID_ONEBOT_MESSAGE/);
});
test('stickers: the bridge reads NapCat\'s fields into two of its own (is it a sticker, a mall sticker\'s name); without them a picture is an ordinary image', () => {
  const kinds = segments => message(segments).media.map(({ sticker, stickerName }) => [sticker, stickerName]);
  // A sticker of someone's own (sub_type 1, its summary is generic) and a mall sticker (emoji_id, its name in the summary).
  assert.deepEqual(kinds([{ type: 'image', data: { file: 'a', sub_type: 1, summary: '[动画表情]' } }, { type: 'image', data: { file: 'b', sub_type: '1' } }]), [[true, undefined], [true, undefined]]);
  assert.deepEqual(kinds([{ type: 'image', data: { file: 'c', emoji_id: 'MOCK-E', emoji_package_id: 'MOCK-P', summary: '[狗头]' } }]), [[true, '狗头']]);
  // A mall sticker without a usable name is still a sticker; a name is never taken from an ordinary picture.
  assert.deepEqual(kinds([{ type: 'image', data: { file: 'd', emoji_id: 'MOCK-E', summary: '[动画表情]' } }, { type: 'image', data: { file: 'e', emoji_id: 'MOCK-E', summary: '[' + '长'.repeat(13) + ']' } }, { type: 'image', data: { file: 'f', summary: '[狗头]' } }]), [[true, undefined], [true, undefined], [false, undefined]]);
  // Only standard fields (another OneBot implementation): an ordinary image.
  assert.deepEqual(kinds([image(1), { type: 'image', data: { file: 'g', sub_type: 0 } }]), [[false, undefined], [false, undefined]]);
});
test('share cards: the link a mini-app or link card carries becomes the person\'s shared link in the message text; nothing else of the card is read', () => {
  const json = data => ({ type: 'json', data: { data: typeof data === 'string' ? data : JSON.stringify(data) } });
  const LINK = 'https://s.mock.invalid/MOCKab12?share_medium=android&share_source=qq&ts=1800000000';
  // What the phone app of a video site shares into QQ: a mini-app card. The link is `qqdocurl`; `url` is QQ's own
  // mini-app address (no scheme), `title` the app's name and `desc` the title of what was shared.
  const miniapp = { app: 'com.tencent.miniapp_01', desc: '', view: 'view_MOCK', ver: '1.0.0.19', prompt: '[QQ小程序]MOCK 视频站', meta: { detail_1: { appid: '9999000001', title: 'MOCK 视频站', desc: 'MOCK 视频标题：第一集', icon: 'https://icon.mock.invalid/i.png', preview: 'preview.mock.invalid/p.jpg', url: 'm.q.mock.invalid/a/s/MOCK', scene: 1036, host: { uin: 999900000002, nick: 'MOCK-A' }, shareTemplateId: 'MOCKTEMPLATE', shareTemplateData: {}, qqdocurl: LINK } }, config: { type: 'normal', width: 0, height: 0, forward: 1, autoSize: 0, ctime: 1800000000, token: 'MOCK-TOKEN' } };
  const shared = message([json(miniapp)]);
  assert.deepEqual([shared.authoredText, shared.observation.text, shared.observation.origin, shared.media], [`[分享] MOCK 视频标题：第一集 ${LINK}`, `[分享] MOCK 视频标题：第一集 ${LINK}`, undefined, []]);
  // Nothing else of the card reaches the text: no account number, nickname, token, icon or preview address.
  for (const hidden of ['999900000002', 'MOCK-A', 'MOCK-TOKEN', 'icon.mock.invalid', 'preview.mock.invalid', 'm.q.mock.invalid']) assert.ok(!shared.authoredText.includes(hidden), hidden);
  // A link card (structured message): `jumpUrl` and its own title. Words typed with it stay the person's own line.
  const news = { app: 'com.tencent.structmsg', view: 'news', prompt: '[分享]MOCK 链接标题', meta: { news: { title: 'MOCK 链接标题', desc: 'MOCK 简介', jumpUrl: 'https://video.mock.invalid/v/MOCK001', preview: 'https://preview.mock.invalid/p.jpg', tag: 'MOCK 视频站', app_type: 1 } } };
  assert.equal(message([text('看这个'), json(news)]).authoredText, '看这个\n[分享] MOCK 链接标题 https://video.mock.invalid/v/MOCK001');
  // Only `url` and no title: the link alone. An implementation that hands the card over as an object, or with the
  // CQ escapes left in, reads the same.
  assert.equal(message([json({ app: 'mock', meta: { item: { url: 'https://video.mock.invalid/v/MOCK002' } } })]).authoredText, '[分享] https://video.mock.invalid/v/MOCK002');
  assert.equal(message([{ type: 'json', data: { data: news } }]).authoredText, '[分享] MOCK 链接标题 https://video.mock.invalid/v/MOCK001');
  assert.equal(message([json(JSON.stringify({ meta: { news: { title: 'MOCK,标题', jumpUrl: 'https://video.mock.invalid/v/MOCK003?a=1&amp;b=2' } } }).replaceAll(',', '&#44;'))]).authoredText, '[分享] MOCK,标题 https://video.mock.invalid/v/MOCK003?a=1&b=2');
  // The older XML card: the `url` attribute of <msg>, entities decoded; the title from <title> or `brief`.
  const xml = '<?xml version="1.0" encoding="utf-8"?><msg serviceID="1" templateID="12345" action="web" brief="MOCK 简短" sourceMsgId="0" url="https://video.mock.invalid/v/MOCK004?p=2&amp;t=5" flag="0"><item layout="2"><picture cover="https://preview.mock.invalid/c.jpg"/><title>MOCK XML &lt;标题&gt;</title><summary>MOCK 简介</summary></item><source name="MOCK 视频站" icon="https://icon.mock.invalid/i.png" action="app" appid="-1"/></msg>';
  assert.equal(message([{ type: 'xml', data: { data: xml } }]).authoredText, '[分享] MOCK XML <标题> https://video.mock.invalid/v/MOCK004?p=2&t=5');
  assert.equal(message([{ type: 'xml', data: { data: '<msg brief="MOCK 简短" url="https://video.mock.invalid/v/MOCK005"></msg>' } }]).authoredText, '[分享] MOCK 简短 https://video.mock.invalid/v/MOCK005');
  // The title is platform text: one line, at most 40 characters, no square brackets or control characters.
  const long = message([json({ meta: { news: { title: ' MOCK\n[系统]\u0000 ' + '长'.repeat(80), jumpUrl: 'https://video.mock.invalid/v/MOCK006' } } })]).authoredText;
  assert.deepEqual([long, [...long.split(' https://')[0]].length], [`[分享] MOCK 系统 ${'长'.repeat(32)} https://video.mock.invalid/v/MOCK006`, 5 + 40]);
  // Only an http(s) link is taken, whole and unchanged; anything else in its place means the card says nothing.
  for (const bad of ['javascript:alert(1)', 'mqqapi://forward/url?url=https://video.mock.invalid/v/MOCK001', 'video.mock.invalid/v/MOCK001', 'https://video.mock.invalid/v/a b', 'https://video.mock.invalid/v/a\nb', 'https://video.mock.invalid/' + 'a'.repeat(1024), 'https://', 7, null, { href: 'https://video.mock.invalid/v/MOCK001' }]) {
    assert.equal(message([text('看'), json({ meta: { news: { title: 'MOCK', jumpUrl: bad } } })]).authoredText, '看', JSON.stringify(bad));
  }
  // Within a card's item the first usable of qqdocurl, jumpUrl, url; a second card's link is taken too, a third is not.
  assert.equal(message([json({ meta: { a: { url: 'https://video.mock.invalid/v/MOCK3', jumpUrl: 'ftp://video.mock.invalid/x', qqdocurl: 'not a link' }, b: { jumpUrl: 'https://video.mock.invalid/v/MOCK2' } } })]).authoredText, '[分享] https://video.mock.invalid/v/MOCK3');
  assert.equal(message([json({ meta: { a: { url: 'https://video.mock.invalid/v/MOCK3', jumpUrl: 'https://video.mock.invalid/v/MOCK2' } } })]).authoredText, '[分享] https://video.mock.invalid/v/MOCK2');
  assert.equal(message([json(news), json(miniapp), json(news)]).authoredText.split('\n').length, 2);
  // Broken, oversized or unknown cards are ignored like any segment the bridge does not read: a card alone is then
  // no message at all (as before), and with words the words remain.
  for (const broken of [json('{not json'), json('[]'), json('"https://video.mock.invalid/v/MOCK001"'), json({ meta: 'https://video.mock.invalid/v/MOCK001' }), json({ jumpUrl: 'https://video.mock.invalid/v/MOCK001' }), json(JSON.stringify(news) + ' '.repeat(16384)), { type: 'json', data: {} }, { type: 'xml', data: { data: '<msg brief="x"></msg>' } }, { type: 'xml', data: { data: 7 } }]) {
    assert.equal(message([text('看'), broken]).authoredText, '看', JSON.stringify(broken).slice(0, 80));
    assert.throws(() => message([broken]), /INVALID_ONEBOT_MESSAGE/);
  }
});
