import { validDelivery } from './executor.js';

/** The most characters of a part's description shown to her. */
export const DELIVERY_DESCRIPTION_CHARS = 40;
const NOUNS = { sticker: '表情包', image: '图片', attachment: '附件' };

/** A description comes from the channel (often machine text): one short line, no control characters, square
 * brackets made full-width so it cannot close the bracket it is shown in, note delimiters neutralized. */
function brief(description, neutralize) {
  const chars = [...description.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replaceAll('[', '［').replaceAll(']', '］').replace(/\s+/g, ' ').trim().replace(/[。.！!]+$/u, '')];
  return neutralize(chars.length > DELIVERY_DESCRIPTION_CHARS ? chars.slice(0, DELIVERY_DESCRIPTION_CHARS).join('') + '…' : chars.join(''));
}
/** What became of one part that is not text or voice. Never "sent" without the platform's receipt. */
function outcome(part, neutralize) {
  const noun = NOUNS[part.kind], described = part.description === undefined ? '' : brief(part.description, neutralize);
  if (part.status === 'sent') return described ? `${noun}：${described}${part.machine ? '（机器描述）' : ''}` : `${noun}：已发出，没有描述`;
  if (part.status === 'unknown') return `${noun}：发送状态未知，不确定对方有没有收到`;
  return part.reason === 'none' ? `${noun}：没有挑出能发的，没发出` : `${noun}：没发出`;
}
/** What became of her words, or null when they went out whole as text. Messages are sent in order and sending
 * stops at the first that fails, so the delivered ones are the first ones. */
function words(parts) {
  const voice = parts.find(part => part.kind === 'voice'), texts = parts.filter(part => part.kind === 'text');
  if (voice) return voice.status === 'sent' ? '这条是用语音发出的' : voice.status === 'unknown' ? '这条用语音发，发送状态未知，不确定对方有没有收到' : '这条的语音没有发出';
  if (!texts.length) return null;
  const count = status => texts.filter(part => part.status === status).length, sent = count('sent'), unknown = count('unknown'), unsent = count('unsent');
  const fallback = texts.some(part => part.fallback === 'voice') ? '语音没有合成出来，改用文字' : '';
  if (sent === texts.length) return fallback ? fallback + '发出了' : null;
  let said;
  if (unsent === texts.length) said = '这条回复没有发出';
  else if (texts.length === 1) said = '这条回复的发送状态未知，不确定对方有没有收到';
  else {
    const chars = texts.filter(part => part.status === 'sent').reduce((total, part) => total === null || part.chars === undefined ? null : total + part.chars, 0);
    said = `拆成 ${texts.length} 条发：` + [sent ? `前 ${sent} 条已送达${chars ? `（约 ${chars} 字）` : ''}` : '', unknown ? `${unknown} 条状态未知` : '', unsent ? `${unsent} 条没发出` : ''].filter(Boolean).join('，');
  }
  return fallback ? `${fallback}；${said}` : said;
}

/**
 * A stored assistant message as it is replayed, given the delivery record kept with it (`message.delivery`, see
 * executor.js). Only what differs from what she wrote is added: a reply that went out whole as text is returned as
 * written. A part's marker in her text is replaced by what became of the part; anything else (voice, a text fallback,
 * messages not delivered or of unknown status, parts without a marker) is one bracketed line each after her text.
 * The record itself is the executor's own and is never sent to the provider. An invalid record changes nothing.
 */
export function replayDelivered(message, neutralize) {
  const { delivery, ...plain } = message;
  if (plain.role !== 'assistant' || !Array.isArray(plain.content) || !validDelivery(delivery)) return plain;
  const content = plain.content.map(block => ({ ...block })), lines = [], said = words(delivery.parts);
  const text = block => block.type === 'text' && typeof block.text === 'string';
  if (said) lines.push(said);
  for (const part of delivery.parts) {
    if (part.kind === 'text' || part.kind === 'voice') continue;
    const result = outcome(part, neutralize), block = part.marker === undefined ? undefined : content.find(block => text(block) && block.text.includes(part.marker));
    // A function as the replacement: the outcome is taken literally (no `$` patterns).
    if (block) block.text = block.text.replace(part.marker, () => `[${result}]`); else lines.push(result);
  }
  if (!lines.length) return { ...plain, content };
  const tail = lines.map(line => `[送达情况：${line}]`).join('\n'), last = content.findLast(text);
  if (last) last.text += '\n' + tail; else content.push({ type: 'text', text: tail });
  return { ...plain, content };
}
