// The notebook: one person's open diaries, read with that person's passcode ("日记口令", which she hands out in
// that person's own private chat). The page posts the passcode to its own server (serve.mjs, real mode), which asks
// Authority with the room credential; the page holds no credential and never talks to Authority. The passcode and
// the diaries live in this page's memory only: nothing is put in storage, the address or the room state.

/** What the notebook says when it cannot show a diary. Every wrong passcode gets the same sentence. */
export const DIARY_ERRORS = Object.freeze({
  wrong: '口令不对，或者还没有写给你的日记。',
  limited: '试得太多了，过一分钟再试。',
  unavailable: '日记暂时读不到，稍后再试。',
});
/** In the fake preview (no Authority behind the page) this passcode opens two made-up pages. */
export const FAKE_CODE = 'demo2345';
export const FAKE_DIARIES = Object.freeze([
  { day: '2026-11-18', text: '（假数据）今天你说想周末去钓鱼，我记下了。希望那天不要下雨。' },
  { day: '2026-11-17', text: '（假数据）你讲了小时候养的那只猫。我想了很久，原来你也会舍不得。' },
].map(Object.freeze));
/** A passcode as typed: blanks around it and letter case do not matter. */
export const typedCode = value => String(value ?? '').trim().toLowerCase();
/** The diaries of an answer, held to their shape: a Beijing day and a text each, nothing else kept. */
export function acceptDiaries(value) {
  if (!value || !Array.isArray(value.diaries) || value.diaries.length > 40) throw new Error(DIARY_ERRORS.unavailable);
  return value.diaries.map(entry => {
    if (!entry || typeof entry.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day) || typeof entry.text !== 'string' || !entry.text || entry.text.length > 600) throw new Error(DIARY_ERRORS.unavailable);
    return { day: entry.day, text: entry.text };
  });
}
/** The diaries this passcode opens, newest first. Throws an Error whose message is one of DIARY_ERRORS.
 * `fake`: the preview without Authority, where only FAKE_CODE opens anything. */
export async function readDiaries(code, { fake = false } = {}) {
  const typed = typedCode(code);
  if (fake) { if (typed !== FAKE_CODE) throw new Error(DIARY_ERRORS.wrong); return FAKE_DIARIES.map(entry => ({ ...entry })); }
  let response;
  try { response = await fetch('diary', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: typed }) }); } catch { throw new Error(DIARY_ERRORS.unavailable); }
  if (response.status === 404) throw new Error(DIARY_ERRORS.wrong);
  if (response.status === 429) throw new Error(DIARY_ERRORS.limited);
  if (!response.ok) throw new Error(DIARY_ERRORS.unavailable);
  let value; try { value = await response.json(); } catch { throw new Error(DIARY_ERRORS.unavailable); }
  return acceptDiaries(value);
}
