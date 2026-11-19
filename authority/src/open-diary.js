// The open diary's list of people, their passcodes, and the one place an open diary is read by its person.
//
// Who gets an open diary is the owner's list (console). Until it is first changed it holds the owner alone.
// Each listed person reads their own diaries on the room page with a passcode: a short string whose only job is to
// say which person is asking (the secrecy asked of it is low). Authority keeps a hash only, so a passcode cannot be
// looked up again: asking for it makes a new one and the old one stops working.
//   - the person asks in their own private conversation ("日记口令"): the channel bridge calls `diaryCode` and sends
//     the answer itself; no model sees the request or the passcode, and neither is observed;
//   - the owner resets one in the console (`resetOpenDiaryCode`), which shows the new passcode once.
// `roomDiary` (room credential) answers a passcode with that person's open diaries and nothing else; every wrong
// passcode fails the same way, whatever was wrong with it. A diary is given whatever persona card it was written
// under: it was written for this person, not for a card.
//
// Storage (no schema change): the metadata key 'openDiary' (diary.js), one entry per entity:
//   { people: { [personId]: { codeHash?, codeAt? } } }
// A release from before this ignores the key, lists the diaries (kind 'open') in the console's memory page and
// writes none.
import { createHash, randomInt } from 'node:crypto';
import { closed, fail, identifier } from './identity.js';
import { DiaryDomain, OPEN_DIARY_KEY } from './diary.js';
import { beijingDay } from './consolidation.js';
import { opaquePerson } from './context.js';
import { DEFAULT_ENTITY_ID } from './store.js';

const OWNER = 'person:owner', DAY = 86400000;
export const OPEN_DIARY = Object.freeze({
  /** A passcode: this many characters of an alphabet without look-alikes (no 0/o, 1/l/i). */
  codeChars: 8, alphabet: 'abcdefghjkmnpqrstuvwxyz23456789',
  /** What a passcode shows: the person's open diaries of the last days, newest first. */
  readDays: 30,
});
const CODE = new RegExp(`^[${OPEN_DIARY.alphabet}]{${OPEN_DIARY.codeChars}}$`);
const codeHash = code => createHash('sha256').update('diary-code:' + code).digest('hex');
/** A passcode as typed: surrounding blanks and letter case do not matter. Null when it cannot be one. */
const typed = value => { const code = typeof value === 'string' && value.length <= 64 ? value.trim().toLowerCase() : ''; return CODE.test(code) ? code : null; };

export class OpenDiaryDomain extends DiaryDomain {
  #save(all) {
    this.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(OPEN_DIARY_KEY, JSON.stringify(all));
  }
  /** An entity's list for writing: the owner alone until it is first changed. */
  #own(all, entityId) { return all[entityId] ||= { people: { [OWNER]: {} } }; }
  /** A new passcode for a listed person (inside a transaction): unused by anyone, stored as a hash. */
  #issue(all, entry, now) {
    const used = new Set(Object.values(all).flatMap(own => Object.values(own.people).map(person => person.codeHash)));
    let code;
    do code = Array.from({ length: OPEN_DIARY.codeChars }, () => OPEN_DIARY.alphabet[randomInt(OPEN_DIARY.alphabet.length)]).join(''); while (used.has(codeHash(code)));
    entry.codeHash = codeHash(code); entry.codeAt = now;
    this.#save(all);
    return code;
  }
  /** Operator only: everyone known, whether they are on the list, whether they have a passcode (never the passcode
   * or its hash), and how many open diaries they have. */
  openDiaryList(input = {}) {
    closed(input, ['entityId'], []);
    const e = this.entity(input.entityId ?? DEFAULT_ENTITY_ID), listed = this.openDiaryState()[e.id]?.people ?? { [OWNER]: {} };
    const written = Object.fromEntries(this.store.db.prepare("SELECT json_extract(body,'$.personId') AS personId,COUNT(*) AS diaries,MAX(json_extract(body,'$.day')) AS lastDay FROM diaries WHERE entity_id=? AND kind='open' GROUP BY 1").all(e.id).map(row => [row.personId, row]));
    const known = this.store.db.prepare('SELECT person_id AS personId FROM actors GROUP BY person_id ORDER BY MIN(rowid)').all().map(row => row.personId);
    const people = [...new Set([OWNER, ...known, ...Object.keys(listed)])].map(personId => ({
      personId, label: opaquePerson(personId), owner: personId === OWNER, listed: Object.hasOwn(listed, personId),
      hasCode: typeof listed[personId]?.codeHash === 'string', codeAt: listed[personId]?.codeAt ?? null,
      diaries: written[personId]?.diaries ?? 0, lastDay: written[personId]?.lastDay ?? null,
    }));
    return { entityId: e.id, people };
  }
  /** Operator only: puts a known person on the list or takes them off. Off the list their passcode is gone and no
   * diary is written for them; what was written stays (and is read again only once they are back with a new passcode). */
  setOpenDiaryListed(input) {
    closed(input, ['entityId', 'personId', 'listed'], ['personId', 'listed']);
    identifier(input.personId);
    if (typeof input.listed !== 'boolean') fail('VALIDATION_ERROR', 'listed must be boolean');
    return this.store.transaction(() => {
      const e = this.entity(input.entityId ?? DEFAULT_ENTITY_ID), all = this.openDiaryState(), own = this.#own(all, e.id);
      if (input.personId !== OWNER && !this.store.db.prepare('SELECT 1 FROM actors WHERE person_id=? LIMIT 1').get(input.personId)) fail('VALIDATION_ERROR', 'Unknown person');
      if (Object.hasOwn(own.people, input.personId) !== input.listed) {
        if (input.listed) own.people[input.personId] = {}; else delete own.people[input.personId];
        this.#save(all);
        this.store.audit({ type: 'diary.open.listed', entityId: e.id, person: opaquePerson(input.personId), listed: input.listed, revision: this.store.nextRevision(), at: this.now() });
      }
      return this.openDiaryList({ entityId: e.id });
    });
  }
  /** Operator only: a new passcode for a listed person, returned once so the owner can pass it on. The old one stops working. */
  resetOpenDiaryCode(input) {
    closed(input, ['entityId', 'personId'], ['personId']);
    identifier(input.personId);
    return this.store.transaction(() => {
      const e = this.entity(input.entityId ?? DEFAULT_ENTITY_ID), all = this.openDiaryState(), own = this.#own(all, e.id), now = this.now();
      if (!Object.hasOwn(own.people, input.personId)) fail('CONFLICT', 'Not on the open diary list', 409);
      const code = this.#issue(all, own.people[input.personId], now);
      this.store.audit({ type: 'diary.open.code', entityId: e.id, person: opaquePerson(input.personId), by: 'operator', revision: this.store.nextRevision(), at: now });
      return { entityId: e.id, personId: input.personId, label: opaquePerson(input.personId), code, codeAt: now };
    });
  }
  /** A conversation channel's credential, for a private conversation of its own: the person of that conversation
   * asked for their passcode. On the list: a new one (`{listed:true,code}`), which the bridge sends itself. Not on
   * the list, or not a private conversation: `{listed:false}`. The caller names a conversation, never a person. */
  diaryCode(capabilityId, input) {
    closed(input, ['streamId']);
    identifier(input.streamId);
    if (!this.conversationChannel(capabilityId)) fail('FORBIDDEN', 'Not a conversation channel', 403);
    return this.store.transaction(() => {
      const stream = this.store.db.prepare('SELECT person_id AS personId,audience,entity_id AS entityId FROM streams WHERE capability_id=? AND stream_id=?').get(capabilityId, input.streamId);
      if (!stream) fail('FORBIDDEN', 'Unbound stream', 403);
      const all = this.openDiaryState(), own = this.#own(all, stream.entityId), now = this.now();
      if (stream.audience !== 'private' || !Object.hasOwn(own.people, stream.personId)) return { listed: false };
      const code = this.#issue(all, own.people[stream.personId], now);
      this.store.audit({ type: 'diary.open.code', entityId: stream.entityId, person: opaquePerson(stream.personId), by: 'person', revision: this.store.nextRevision(), at: now });
      return { listed: true, code };
    });
  }
  /** Room credential only. The open diaries of the person this passcode belongs to: their days and texts, newest
   * first, of the last `readDays` days. No person, card or id is returned. Anything that is not a listed person's
   * current passcode fails with the same NOT_FOUND. */
  roomDiary(input) {
    this.store.check();
    const code = input !== null && typeof input === 'object' ? typed(input.code) : null, hash = code === null ? null : codeHash(code);
    let found = null;
    if (hash !== null) for (const [entityId, own] of Object.entries(this.openDiaryState())) for (const [personId, entry] of Object.entries(own.people)) if (entry.codeHash === hash) found = { entityId, personId };
    if (!found) fail('NOT_FOUND', 'No diary for this passcode', 404);
    const since = beijingDay(this.now() - OPEN_DIARY.readDays * DAY);
    const diaries = this.store.db.prepare("SELECT json_extract(body,'$.day') AS day,json_extract(body,'$.text') AS text FROM diaries WHERE entity_id=? AND kind='open' AND json_extract(body,'$.personId')=? AND json_extract(body,'$.day')>=? ORDER BY json_extract(body,'$.day') DESC,revision DESC LIMIT ?")
      .all(found.entityId, found.personId, since, OPEN_DIARY.readDays + 1).map(row => ({ day: row.day, text: row.text }));
    return { diaries };
  }
}
