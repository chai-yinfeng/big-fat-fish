// Pure OneBot v11 normalization. Call only after transport authentication.
// Account attribution comes from the envelope, never attachment text or OCR.
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
const mediaFile = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.includes('\0');
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
  const media = []; let authoredText;
  if (typeof event.message === 'string') authoredText = event.message; // CQ-looking text remains literal text.
  else if (Array.isArray(event.message) && event.message.length <= 32) {
    authoredText = event.message.filter(s => s?.type === 'text' && typeof s.data?.text === 'string').map(s => s.data.text).join('\n');
    for (const [segmentIndex, segment] of event.message.entries()) {
      const data = segment?.data;
      if (segment?.type === 'record' && mediaFile(data?.file)) media.push({ kind: 'audio', file: data.file, segmentIndex });
      else if (segment?.type === 'image' && mediaFile(data?.file)) media.push({ kind: 'image', file: data.file, segmentIndex, sticker: typeof data.emoji_id === 'string' });
      else if (segment?.type === 'face' && /^\d{1,10}$/.test(String(data?.id))) media.push({ kind: 'sticker', native: { type: 'qq-face', id: String(data.id) }, segmentIndex });
    }
  } else throw new Error('INVALID_ONEBOT_MESSAGE');
  if (typeof authoredText !== 'string' || authoredText.length > 16000 || authoredText.includes('\0') || !authoredText && !media.length || media.length > 4 || media.filter(m => m.kind === 'audio').length > 1) throw new Error('INVALID_ONEBOT_MESSAGE');
  const placeholder = media.length === 1 ? { audio: '[QQ语音消息]', image: '[QQ图片消息]', sticker: '[QQ表情消息]' }[media[0].kind] : '[QQ附件消息]';
  const anonymous = event.anonymous != null;
  return { authoredText, media, observation: { eventId: `onebot:v11:message:${messageId}`, streamId: group ? `qq:${self}:group:${group}` : `qq:${self}:private:${sender}`, actorId: anonymous ? `qq:${self}:anonymous` : `qq:${self}:user:${sender}`, role: anonymous ? 'external' : 'user', text: authoredText || placeholder, at: event.time * 1000, ...(!authoredText.trim() ? { origin: 'attachment' } : {}) } };
}
export function observationFromOneBot(event, config) { return messageFromOneBot(event, config)?.observation || null; }
