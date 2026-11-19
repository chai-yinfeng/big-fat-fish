// Pure OneBot v11 normalization. Call only after transport authentication.
// Account attribution comes from the envelope, never attachment text or OCR.
import { faceText } from './faces.js';

function id(value, signed = false) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('INVALID_ONEBOT_ID');
    value = String(value);
  }
  if (typeof value !== 'string' || value.length > 20 || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) throw new Error('INVALID_ONEBOT_ID');
  const normalized = BigInt(value).toString();
  if (!signed && BigInt(normalized) <= 0n) throw new Error('INVALID_ONEBOT_ID');
  return normalized;
}
/** Most pictures and voice clips taken from one message. */
export const MAX_MEDIA = 4;
const mediaFile = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.includes('\0');
/** Is an image segment a sticker, and what is a mall sticker called: the two internal fields everything after the
 * bridge relies on (with the picture's hash). Both come from NapCat-only fields, known only second-hand: `emoji_id`
 * (a mall sticker, `summary` its name in brackets) and `sub_type: 1` (a sticker of someone's own). An implementation
 * without them gives neither: the picture is an ordinary image, looked at once like any other. */
function stickerOf(data) {
  const mall = typeof data.emoji_id === 'string' && data.emoji_id.length > 0;
  const name = mall && typeof data.summary === 'string' ? data.summary.trim().replace(/^\[(.*)\]$/s, '$1').trim() : '';
  return { sticker: mall || data.sub_type === 1 || data.sub_type === '1', ...(name && name.length <= 12 && !/[\n\0[\]]/.test(name) && !['动画表情', '图片', '表情'].includes(name) ? { stickerName: name } : {}) };
}
/** Share cards (`json` and `xml` segments) read from one message, the longest card read, link and title kept. */
export const CARD = Object.freeze({ perMessage: 2, chars: 16384, url: 1024, title: 40 });
const CQ_ESCAPES = { '&#44;': ',', '&#91;': '[', '&#93;': ']', '&amp;': '&' }, XML_ESCAPES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': '\'', '&amp;': '&' };
const unescaped = (value, table) => value.replace(/&(?:#44|#91|#93|amp|lt|gt|quot|apos);/g, found => table[found] ?? found);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Only a whole http(s) link in printable ASCII is a link; it is kept exactly as the card has it. */
const cardLink = value => typeof value === 'string' && value.length <= CARD.url && /^https?:\/\/[\x21-\x7e]+$/.test(value) && URL.canParse(value) ? value : null;
/** A card's title is the platform's or a third party's text, not the person's: one short line without brackets. */
const cardTitle = value => typeof value === 'string' ? [...value.replace(/[\[\]\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, CARD.title).join('').trim() : '';
/** What a share card says, as one line of the person's message: `[分享] <title> <link>`, or null when the card
 * carries no usable link. A phone app usually shares a mini-app or link card instead of typing the link; which
 * fields carry it is NapCat's rendering of QQ's card (known second-hand, like the sticker fields): in a `json` card
 * `qqdocurl`, `jumpUrl` or `url` of an item directly under `meta`, in an `xml` card the `url` attribute of `<msg>`.
 * Nothing else of the card is read, nothing is fetched or followed, and another card shape is ignored. */
function cardText(type, data) {
  let raw = data?.data, link = null, title = '';
  if (type === 'json') {
    if (typeof raw === 'string') {
      if (raw.length > CARD.chars) return null;
      const text = raw;
      try { raw = JSON.parse(text); } catch { try { raw = JSON.parse(unescaped(text, CQ_ESCAPES)); } catch { return null; } }
    }
    if (!plain(raw) || !plain(raw.meta)) return null;
    for (const item of Object.values(raw.meta).slice(0, 8)) {
      if (!plain(item)) continue;
      const key = ['qqdocurl', 'jumpUrl', 'url'].find(name => cardLink(item[name]));
      if (!key) continue;
      // A mini-app card names the app in `title` and what was shared in `desc`; a link card has its title in `title`.
      link = item[key]; title = key === 'qqdocurl' ? cardTitle(item.desc) || cardTitle(item.title) : cardTitle(item.title);
      break;
    }
  } else {
    if (typeof raw !== 'string' || raw.length > CARD.chars) return null;
    const head = /<msg\b[^>]*>/.exec(raw)?.[0] ?? '', attribute = name => unescaped(new RegExp(`\\s${name}="([^"]*)"`).exec(head)?.[1] ?? '', XML_ESCAPES);
    link = cardLink(attribute('url'));
    title = cardTitle(unescaped(/<title>([^<]*)<\/title>/.exec(raw)?.[1] ?? '', XML_ESCAPES)) || cardTitle(attribute('brief'));
  }
  return link ? `[分享] ${title ? title + ' ' : ''}${link}` : null;
}
/** One log line per image segment of an inbound message, to see which NapCat-only fields really arrive: the names of
 * the segment's data fields, `sub_type`, whether `emoji_id` is there and the `summary` string. Never a value of any
 * other field (no file name, URL, account number or message text). */
export function imageProbeLines(event) {
  if (!Array.isArray(event?.message)) return [];
  return event.message.filter(segment => segment?.type === 'image' && segment.data && typeof segment.data === 'object').map(({ data }) => {
    const keys = Object.keys(data).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(key)).slice(0, 24).join(',');
    const subType = typeof data.sub_type === 'number' && Number.isSafeInteger(data.sub_type) || typeof data.sub_type === 'string' && /^\w{1,16}$/.test(data.sub_type) ? data.sub_type : data.sub_type === undefined ? '-' : '?';
    const summary = typeof data.summary === 'string' ? JSON.stringify(data.summary.slice(0, 24)) : '-';
    return `qq image segment: keys=${keys || '-'} sub_type=${subType} emoji_id=${data.emoji_id !== undefined && data.emoji_id !== '' ? 'yes' : 'no'} summary=${summary}`;
  });
}
export function messageFromOneBot(event, { expectedSelfId }) {
  if (!event || typeof event !== 'object' || event.post_type !== 'message') return null;
  const self = id(event.self_id);
  if (self !== id(expectedSelfId)) throw new Error('UNEXPECTED_ONEBOT_ACCOUNT');
  const sender = id(event.user_id);
  if (event.sender?.user_id !== undefined && id(event.sender.user_id) !== sender) throw new Error('CONFLICTING_ONEBOT_SENDER');
  if (sender === self) return null;
  if (!['private', 'group'].includes(event.message_type)) throw new Error('INVALID_ONEBOT_CHANNEL');
  const group = event.message_type === 'group' ? id(event.group_id) : null, messageId = id(event.message_id, true);
  if (!Number.isSafeInteger(event.time) || event.time < 0 || event.time > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) throw new Error('INVALID_ONEBOT_TIME');
  // Pictures and voice beyond MAX_MEDIA are not fetched; `skippedMedia` counts them, so the model is told.
  const media = []; let authoredText, skippedMedia = 0, audio = 0;
  if (typeof event.message === 'string') authoredText = event.message; // CQ-looking text remains literal text.
  else if (Array.isArray(event.message) && event.message.length <= 32) {
    // Text segments joined by line breaks; a small face is its name (`[微笑]`) where it stands, not an attachment.
    // A share card is the line `[分享] <title> <link>` (cardText), at most CARD.perMessage of them.
    const pieces = []; let cards = 0;
    for (const [segmentIndex, segment] of event.message.entries()) {
      const data = segment?.data;
      if (segment?.type === 'text' && typeof data?.text === 'string') pieces.push({ text: data.text, line: true });
      else if (segment?.type === 'face' && /^\d{1,10}$/.test(String(data?.id))) pieces.push({ text: faceText(String(data.id)) });
      else if (segment?.type === 'record' && mediaFile(data?.file)) { audio++; if (media.length < MAX_MEDIA) media.push({ kind: 'audio', file: data.file, segmentIndex }); else skippedMedia++; }
      else if (segment?.type === 'image' && mediaFile(data?.file)) { if (media.length < MAX_MEDIA) media.push({ kind: 'image', file: data.file, segmentIndex, ...stickerOf(data) }); else skippedMedia++; }
      else if ((segment?.type === 'json' || segment?.type === 'xml') && cards < CARD.perMessage) { const shared = cardText(segment.type, data); if (shared) { cards++; pieces.push({ text: shared, line: true }); } }
    }
    authoredText = pieces.map((piece, index) => (piece.line && pieces[index - 1]?.line ? '\n' : '') + piece.text).join('');
  } else throw new Error('INVALID_ONEBOT_MESSAGE');
  if (typeof authoredText !== 'string' || authoredText.length > 16000 || authoredText.includes('\0') || !authoredText && !media.length || audio > 1) throw new Error('INVALID_ONEBOT_MESSAGE');
  const placeholder = media.length === 1 ? { audio: '[QQ语音消息]', image: '[QQ图片消息]' }[media[0].kind] : '[QQ附件消息]';
  const anonymous = event.anonymous != null;
  return { authoredText, media, skippedMedia, observation: { eventId: `onebot:v11:message:${messageId}`, streamId: group ? `qq:${self}:group:${group}` : `qq:${self}:private:${sender}`, actorId: anonymous ? `qq:${self}:anonymous` : `qq:${self}:user:${sender}`, role: anonymous ? 'external' : 'user', text: authoredText || placeholder, at: event.time * 1000, ...(!authoredText.trim() ? { origin: 'attachment' } : {}) } };
}
export function observationFromOneBot(event, config) { return messageFromOneBot(event, config)?.observation || null; }
