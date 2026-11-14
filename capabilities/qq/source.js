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
    const pieces = [];
    for (const [segmentIndex, segment] of event.message.entries()) {
      const data = segment?.data;
      if (segment?.type === 'text' && typeof data?.text === 'string') pieces.push({ text: data.text, line: true });
      else if (segment?.type === 'face' && /^\d{1,10}$/.test(String(data?.id))) pieces.push({ text: faceText(String(data.id)) });
      else if (segment?.type === 'record' && mediaFile(data?.file)) { audio++; if (media.length < MAX_MEDIA) media.push({ kind: 'audio', file: data.file, segmentIndex }); else skippedMedia++; }
      else if (segment?.type === 'image' && mediaFile(data?.file)) { if (media.length < MAX_MEDIA) media.push({ kind: 'image', file: data.file, segmentIndex, ...stickerOf(data) }); else skippedMedia++; }
    }
    authoredText = pieces.map((piece, index) => (piece.line && pieces[index - 1]?.line ? '\n' : '') + piece.text).join('');
  } else throw new Error('INVALID_ONEBOT_MESSAGE');
  if (typeof authoredText !== 'string' || authoredText.length > 16000 || authoredText.includes('\0') || !authoredText && !media.length || audio > 1) throw new Error('INVALID_ONEBOT_MESSAGE');
  const placeholder = media.length === 1 ? { audio: '[QQ语音消息]', image: '[QQ图片消息]' }[media[0].kind] : '[QQ附件消息]';
  const anonymous = event.anonymous != null;
  return { authoredText, media, skippedMedia, observation: { eventId: `onebot:v11:message:${messageId}`, streamId: group ? `qq:${self}:group:${group}` : `qq:${self}:private:${sender}`, actorId: anonymous ? `qq:${self}:anonymous` : `qq:${self}:user:${sender}`, role: anonymous ? 'external' : 'user', text: authoredText || placeholder, at: event.time * 1000, ...(!authoredText.trim() ? { origin: 'attachment' } : {}) } };
}
export function observationFromOneBot(event, config) { return messageFromOneBot(event, config)?.observation || null; }
