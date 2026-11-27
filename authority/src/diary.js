// Her diary: once a Beijing day she writes about the day that just ended. First, in one model call, a private
// diary (hers and the owner's alone: it may be about particular people, and it carries her line of thought from
// one day to the next). Then the open diaries: one for each person on the owner's list (open-diary.js; by default
// the owner alone), each in a call of its own whose input is that one person's digests of the day and nothing of
// anyone else; no private diary is read for it. A person without material that day gets none. The worker only
// carries text: Authority decides when, builds the input, validates the answer and writes.
//
// A diary is subjective memory: it carries the id of the persona card it was written under, and the earlier
// private diaries she reads while writing are those of that same card only (a diary without a card id belongs
// to the default card, as in cards.js). A private diary is read in one other place: the newest one of the current card, in her private wake-up (wake.js), which is
// nobody's conversation. No conversation with a person and no memory tool reads it.
// An open diary carries the card id as a record only: it is written for its person, who reads it whatever card is
// current (open-diary.js); no conversation and no memory tool reads it either.
//
// Storage (no schema change): `diaries` rows of kind 'private' / 'open' with body
// `{v:2, day, text, cardId, readDiaryIds, taskId, at}` (private) or `{v:2, day, text, cardId, personId, taskId, at}`
// (open, status 'open'); `diary_sources` links a diary to the digests and notes it used; the marker "last Beijing
// day that is done" lives under the metadata key 'consolidation' (`<entity>.diary` for the private diary,
// `<entity>.openDiary.people.<person>` for each open one), written in the transaction that writes the diary; an
// admitted request is a maintenance_tasks row (mode 'diary' / 'diary.open'); a commit leaves a diary_receipts row
// (kind 'diary') holding a hash only. A diary's call is one of the entity's daily consolidation batches.
import { createHash, randomUUID } from 'node:crypto';
import { SELF_PERSON, canonical, closed, enumeration, fail, identifier } from './identity.js';
import { ConsolidationDomain, CONSOLIDATION, beijingDay, beijingHour } from './consolidation.js';
import { SENSITIVE } from './policies.js';
import { opaquePerson } from './context.js';
import { renderPersona } from './persona.js';
import { DEFAULT_CARD_ID, feelingFor } from './cards.js';

const DAY = 86400000;
export const DIARY = Object.freeze({
  /** Beijing hours: the day that just ended is written from `fromHour` on, once consolidation has nothing left
   * to hand out; from `regardlessHour` on it is written whether consolidation is done or not. */
  fromHour: 3, regardlessHour: 5,
  /** Finished days still written when the worker was not running that night. */
  catchUpDays: 2,
  /** The input: the day's digests (serialized rows), her own notes of the day, her earlier private diaries, the persona. */
  digestChars: 4500, noteChars: 800, previousChars: 1000, previousDiaries: 2, personaChars: 1000,
  /** The diary's text. */
  textChars: 500,
  /** Unusable model answers for a day before that day is given up. */
  maxInvalid: 3,
});
const sha256 = value => createHash('sha256').update(value).digest('hex');
const beijingClock = at => new Date(at + 8 * 3600000).toISOString().slice(11, 16);
const dayStart = day => Date.parse(`${day}T00:00:00+08:00`);
const rowChars = row => JSON.stringify(row).length + 1;
const OWNER = 'person:owner';
/** Metadata key of the open diary's list of people (and their passcodes, see open-diary.js), one entry per entity:
 * `{ people: { [personId]: { codeHash?, codeAt? } } }`. An entity without an entry has the owner alone on its list. */
export const OPEN_DIARY_KEY = 'openDiary';
/** The rows that fit a serialized budget, in the order given (a row that does not fit is left out). */
function within(rows, budget, shape) {
  const kept = []; let chars = 0;
  for (const row of rows) { const size = rowChars({ ref: 'x00', ...shape(row) }); if (chars + size > budget) continue; chars += size; kept.push(row); }
  return kept;
}

export class DiaryDomain extends ConsolidationDomain {
  /** What she has to write from for one Beijing day, under one persona card: the digests of the dialogue that
   * ended that day (every person, each under an opaque label; her feeling only when it was written under this
   * card), her own notes of that day, and her newest earlier private diaries of this card. `refs`: short ref ->
   * memory ID. Over the budget the pinned and the newer digests stay. */
  #material(e, day, cardId) {
    const from = dayStart(day), to = from + DAY, refs = {};
    const digestRow = memory => ({ person: opaquePerson(memory.personId), time: beijingClock(memory.toAt), summary: String(memory.summary ?? ''), ...(feelingFor(memory, cardId) ? { feeling: memory.feeling } : {}) });
    // Never a digest under her own conversation's reserved person (consolidation writes none; this holds regardless).
    // Nor a group digest: what was said in a group is not material of her private diary.
    const found = this.store.db.prepare("SELECT * FROM memory_items WHERE entity_id=? AND COALESCE(person_id,'')<>? AND kind='digest' AND COALESCE(json_extract(body,'$.scope.kind'),'person')<>'group' AND status='active' AND json_extract(body,'$.toAt')>=? AND json_extract(body,'$.toAt')<?").all(e.id, SELF_PERSON, from, to)
      .map(row => this.store.memory(row)).filter(memory => !SENSITIVE.test(`${memory.summary}\n${memory.feeling ?? ''}`));
    const digests = within(found.sort((a, b) => b.pinned - a.pinned || b.toAt - a.toAt), DIARY.digestChars, digestRow).sort((a, b) => a.toAt - b.toAt)
      .map((memory, index) => { const ref = 'd' + (index + 1); refs[ref] = memory.id; return { ref, ...digestRow(memory) }; });
    const noteRow = memory => ({ kind: memory.kind, text: String(memory.text ?? '') });
    const written = this.store.db.prepare("SELECT * FROM memory_items WHERE entity_id=? AND collection='notes' AND kind IN ('outer','inner') AND status='active' AND json_extract(body,'$.at')>=? AND json_extract(body,'$.at')<?").all(e.id, from, to)
      .map(row => this.store.memory(row)).filter(memory => !SENSITIVE.test(String(memory.text ?? '')));
    const notes = within(written.sort((a, b) => b.at - a.at), DIARY.noteChars, noteRow).sort((a, b) => a.at - b.at)
      .map((memory, index) => { const ref = 'n' + (index + 1); refs[ref] = memory.id; return { ref, ...noteRow(memory) }; });
    // Only diaries of this format, of this card, of earlier days.
    const earlier = this.store.db.prepare("SELECT id,body FROM diaries WHERE entity_id=? AND kind='private' AND json_extract(body,'$.v')=2 AND COALESCE(json_extract(body,'$.cardId'),?)=? AND json_extract(body,'$.day')<? ORDER BY json_extract(body,'$.day') DESC,revision DESC LIMIT ?")
      .all(e.id, DEFAULT_CARD_ID, cardId, day, DIARY.previousDiaries).map(row => ({ id: row.id, ...JSON.parse(row.body) }));
    const previous = []; let chars = 0;
    for (const diary of earlier) { if (chars + diary.text.length > DIARY.previousChars) break; chars += diary.text.length; previous.unshift(diary); }
    return { refs, digests, notes, previous: previous.map(diary => ({ day: diary.day, text: diary.text })), readDiaryIds: previous.map(diary => diary.id) };
  }
  /** What she has to write one person's open diary of one Beijing day from: the digests of that person's own
   * dialogue that ended that day (her feeling only when it was written under this card), and nothing else: no
   * other person's row, none of her notes (they may speak of anyone), no private diary. `refs`: short ref ->
   * memory ID. The rows carry no person label: there is only one person in the request. */
  #openMaterial(e, day, cardId, personId) {
    const from = dayStart(day), to = from + DAY, refs = {};
    const digestRow = memory => ({ time: beijingClock(memory.toAt), summary: String(memory.summary ?? ''), ...(feelingFor(memory, cardId) ? { feeling: memory.feeling } : {}) });
    const found = this.store.db.prepare("SELECT * FROM memory_items WHERE entity_id=? AND person_id=? AND kind='digest' AND status='active' AND json_extract(body,'$.toAt')>=? AND json_extract(body,'$.toAt')<?").all(e.id, personId, from, to)
      .map(row => this.store.memory(row)).filter(memory => !SENSITIVE.test(`${memory.summary}\n${memory.feeling ?? ''}`));
    const digests = within(found.sort((a, b) => b.pinned - a.pinned || b.toAt - a.toAt), DIARY.digestChars, digestRow).sort((a, b) => a.toAt - b.toAt)
      .map((memory, index) => { const ref = 'd' + (index + 1); refs[ref] = memory.id; return { ref, ...digestRow(memory) }; });
    return { refs, digests };
  }
  /** Her newest private diary written under one persona card, `{ day, text }` or null. Internal, for her private
   * wake-up (her own conversation, which is nobody's): the second and last place a private diary is read back. */
  latestPrivateDiary(entityId, cardId) {
    const row = this.store.db.prepare("SELECT body FROM diaries WHERE entity_id=? AND kind='private' AND json_extract(body,'$.v')=2 AND COALESCE(json_extract(body,'$.cardId'),?)=? ORDER BY json_extract(body,'$.day') DESC,revision DESC LIMIT 1").get(entityId, DEFAULT_CARD_ID, cardId);
    if (!row) return null;
    const { day, text } = JSON.parse(row.body);
    return typeof day === 'string' && typeof text === 'string' ? { day, text } : null;
  }
  openDiaryState() {
    const row = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(OPEN_DIARY_KEY);
    return row ? JSON.parse(row.value) : {};
  }
  /** The people an open diary is written for, the owner first: the owner's list, or the owner alone until it is first changed. */
  openDiaryRoster(entityId) {
    const own = this.openDiaryState()[entityId];
    return own ? Object.keys(own.people).sort((a, b) => (b === OWNER) - (a === OWNER) || (a < b ? -1 : a > b ? 1 : 0)) : [OWNER];
  }
  /** Maintenance credential only. The diary to write next, or `task: null` with a reason: for each day still due,
   * the private diary first, then the open diary of each listed person (`task.kind` is 'open'). A day, or a
   * person's day, without material is never handed out (no model call); it simply leaves the catch-up window. */
  diaryNext(entityId, input = {}) {
    closed(input, [], []);
    return this.store.transaction(() => {
      const e = this.entity(entityId), world = this.worldStatus(), now = this.now();
      if (world.paused) return { entityId: e.id, task: null, reason: 'paused' };
      const all = this.consolidationState(), stored = JSON.stringify(all), own = this.consolidationOwn(all, e.id, now), diary = own.diary ||= {};
      const roster = this.openDiaryRoster(e.id), openDone = personId => own.openDiary?.people?.[personId]?.lastDay ?? '';
      const today = beijingDay(now), yesterday = beijingDay(now - DAY), hour = beijingHour(now);
      const days = Array.from({ length: DIARY.catchUpDays }, (_, index) => beijingDay(now - (DIARY.catchUpDays - index) * DAY));
      // Staging and tests only (diaryTrigger): the running day, written as if it had ended.
      if (diary.liveDay === today) days.push(today); else delete diary.liveDay;
      const personaText = () => renderPersona({ ...JSON.parse(e.persona), userCallName: '你', relationshipStage: 'new' }).slice(0, DIARY.personaChars);
      let task = null, reason = 'idle', liveDone = false;
      days: for (const day of days) {
        const privateDue = day > (diary.lastDay ?? ''), openDue = roster.filter(personId => day > openDone(personId));
        if (!privateDue && !openDue.length) { liveDone ||= day === today; continue; }
        // (Not `break`: a triggered running day, which only staging has, is not held back by the night hours.)
        if (day === yesterday && hour < DIARY.fromHour) continue;
        // First let consolidation finish with what it can still do, so the day's digests are there.
        if ((day === today || day === yesterday && hour < DIARY.regardlessHour) && this.consolidationWaiting(e.id, now)) break;
        const cardId = this.currentCardId(e.id), material = privateDue ? this.#material(e, day, cardId) : null, ids = material ? Object.values(material.refs) : [];
        if (!ids.length) {
          // The private diary of this day is written (or has nothing to be written from): the open diaries, one
          // person at a time, each from that person's own digests of the day.
          for (const personId of openDue) {
            const mine = this.#openMaterial(e, day, cardId, personId), mineIds = Object.values(mine.refs);
            if (!mineIds.length) continue;
            if (own.calls >= CONSOLIDATION.perDay) { reason = 'budget'; break days; }
            const taskId = sha256(canonical({ kind: 'open', entityId: e.id, personId, day, cardId, ids: mineIds, epoch: e.memory_epoch, worldRevision: world.revision }));
            this.store.db.prepare('INSERT OR IGNORE INTO maintenance_tasks(id,entity_id,epoch,cursor,world_revision,mode,source_ids) VALUES(?,?,?,?,?,?,?)')
              .run(taskId, e.id, e.memory_epoch, 0, world.revision, 'diary.open', JSON.stringify({ day, cardId, personId, refs: mine.refs }));
            own.calls++; (own.openDiary ||= {}).issued = taskId;
            // Short refs and Beijing clock times only; whose diary it is stays in Authority.
            task = { kind: 'open', taskId, day, personaText: personaText(), digests: mine.digests };
            break days;
          }
          liveDone ||= day === today;
          continue;
        }
        if (own.calls >= CONSOLIDATION.perDay) { reason = 'budget'; break; }
        const taskId = sha256(canonical({ entityId: e.id, day, cardId, ids, readDiaryIds: material.readDiaryIds, epoch: e.memory_epoch, worldRevision: world.revision }));
        this.store.db.prepare('INSERT OR IGNORE INTO maintenance_tasks(id,entity_id,epoch,cursor,world_revision,mode,source_ids) VALUES(?,?,?,?,?,?,?)')
          .run(taskId, e.id, e.memory_epoch, 0, world.revision, 'diary', JSON.stringify({ day, cardId, refs: material.refs, readDiaryIds: material.readDiaryIds }));
        // Counted when handed out, like a consolidation batch.
        own.calls++; diary.issued = taskId;
        task = {
          taskId, day,
          personaText: personaText(),
          // Opaque person labels, short refs and Beijing clock times only: no memory, person or stream ID leaves Authority here.
          digests: material.digests, notes: material.notes, previous: material.previous,
          // Her own material of the day (mood, jottings, what she chose to do): nothing produces it yet.
          own: {},
        };
        break;
      }
      // The triggered running day has nothing left to hand out: the trigger is used up, so an open diary of a
      // digest that arrives later the same day waits for the day to end (or for another trigger), as in production.
      if (!task && liveDone) delete diary.liveDay;
      // An idle tick writes nothing.
      if (JSON.stringify(all) !== stored) this.saveConsolidationState(all);
      return task ? { entityId: e.id, task } : { entityId: e.id, task: null, reason };
    });
  }
  /** Maintenance credential only. `outcome`: 'ok' with the model's answer, 'invalid' (unusable answer) or
   * 'deferred' (the gateway's spend tier refused the call: the reservation is returned). */
  diaryCommit(entityId, input) {
    closed(input, ['taskId', 'outcome', 'private', 'open', 'usedIds'], ['taskId', 'outcome']);
    identifier(input.taskId);
    enumeration(input.outcome, ['ok', 'invalid', 'deferred']);
    const encoding = sha256(canonical(input));
    return this.store.transaction(() => {
      const e = this.entity(entityId), world = this.worldStatus(), now = this.now();
      const done = this.store.db.prepare("SELECT canonical FROM diary_receipts WHERE task_id=? AND kind='diary'").get(input.taskId);
      if (done) {
        if (done.canonical !== encoding) fail('CONFLICT', 'Diary retry changed content', 409);
        return { status: 'committed', replayed: true };
      }
      const row = this.store.db.prepare("SELECT * FROM maintenance_tasks WHERE id=? AND entity_id=? AND mode IN ('diary','diary.open')").get(input.taskId, e.id);
      if (!row || world.paused || row.world_revision !== world.revision || row.epoch !== e.memory_epoch) fail('CONFLICT', 'Diary request is no longer current', 409);
      const task = JSON.parse(row.source_ids), all = this.consolidationState(), own = this.consolidationOwn(all, e.id, now), diary = own.diary ||= {};
      if (row.mode === 'diary.open') return this.#commitOpen(e, world, now, input, encoding, task, all, own);
      // Written under the card it was handed out under, or not at all.
      if (task.cardId !== this.currentCardId(e.id) || task.day <= (diary.lastDay ?? '')) fail('CONFLICT', 'Diary request is no longer current', 409);
      const close = () => {
        diary.lastDay = task.day; diary.lastAt = now; delete diary.issued; delete diary.invalid;
        this.store.db.prepare("DELETE FROM maintenance_tasks WHERE entity_id=? AND mode='diary'").run(e.id);
      };
      if (input.outcome === 'deferred') {
        if (diary.issued === input.taskId) { own.calls = Math.max(0, own.calls - 1); delete diary.issued; }
        own.deferredAt = now;
        this.saveConsolidationState(all);
        return { status: 'deferred' };
      }
      const answer = input.outcome === 'ok' ? validAnswer(input, task.refs, 'private') : null;
      if (!answer) {
        if (diary.issued === input.taskId) { diary.invalid = diary.invalid?.day === task.day ? { day: task.day, count: diary.invalid.count + 1 } : { day: task.day, count: 1 }; delete diary.issued; }
        const skipped = diary.invalid?.day === task.day && diary.invalid.count >= DIARY.maxInvalid;
        if (skipped) {
          close(); diary.skipped = (diary.skipped ?? 0) + 1;
          this.store.audit({ type: 'diary.skipped', entityId: e.id, day: task.day, reason: 'invalid_output', revision: this.store.nextRevision(), at: now });
        }
        this.saveConsolidationState(all);
        return { status: skipped ? 'skipped' : 'invalid' };
      }
      // The only check on what she wrote: a diary matching the sensitive lexicon is refused (the day is done all the same).
      const rejected = SENSITIVE.test(answer.text) ? 'sensitive' : null, sourceIds = answer.usedIds.map(ref => task.refs[ref]);
      let privateId = null;
      if (!rejected) {
        privateId = randomUUID();
        this.store.db.prepare('INSERT INTO diaries(id,entity_id,kind,status,revision,world_at,body) VALUES(?,?,?,?,?,?,?)').run(privateId, e.id, 'private', 'private', this.store.nextRevision(), world.worldNow, JSON.stringify({
          v: 2, day: task.day, text: answer.text, cardId: task.cardId, readDiaryIds: task.readDiaryIds, taskId: input.taskId, at: now,
        }));
        for (const sourceId of sourceIds) this.store.db.prepare('INSERT INTO diary_sources(diary_id,memory_id) VALUES(?,?)').run(privateId, sourceId);
      }
      close(); delete own.deferredAt;
      this.store.db.prepare('INSERT INTO diary_receipts(task_id,kind,diary_id,canonical) VALUES(?,?,?,?)').run(input.taskId, 'diary', '', encoding);
      const result = { day: task.day, privateId, ...(rejected ? { rejected } : {}) };
      // IDs, the day, the card and counts only: no diary text.
      this.store.audit({ type: 'diary.committed', entityId: e.id, ...result, cardId: task.cardId, sources: sourceIds.length, read: task.readDiaryIds.length, revision: this.store.nextRevision(), at: now });
      this.saveConsolidationState(all);
      return { status: 'committed', ...result };
    });
  }
  /** The commit of one person's open diary (inside diaryCommit's transaction): the same outcomes and checks as the
   * private one, with its own marker and its own count of unusable answers per person. */
  #commitOpen(e, world, now, input, encoding, task, all, own) {
    const open = own.openDiary ||= {}, mine = (open.people ||= {})[task.personId] ||= {};
    // Written under the card it was handed out under, for someone still on the list, or not at all.
    if (task.cardId !== this.currentCardId(e.id) || !this.openDiaryRoster(e.id).includes(task.personId) || task.day <= (mine.lastDay ?? '')) fail('CONFLICT', 'Diary request is no longer current', 409);
    const close = () => {
      mine.lastDay = task.day; mine.lastAt = now; delete mine.invalid; delete open.issued;
      this.store.db.prepare("DELETE FROM maintenance_tasks WHERE entity_id=? AND mode='diary.open'").run(e.id);
    };
    if (input.outcome === 'deferred') {
      if (open.issued === input.taskId) { own.calls = Math.max(0, own.calls - 1); delete open.issued; }
      own.deferredAt = now;
      this.saveConsolidationState(all);
      return { status: 'deferred' };
    }
    const person = opaquePerson(task.personId), answer = input.outcome === 'ok' ? validAnswer(input, task.refs, 'open') : null;
    if (!answer) {
      if (open.issued === input.taskId) { mine.invalid = mine.invalid?.day === task.day ? { day: task.day, count: mine.invalid.count + 1 } : { day: task.day, count: 1 }; delete open.issued; }
      const skipped = mine.invalid?.day === task.day && mine.invalid.count >= DIARY.maxInvalid;
      if (skipped) {
        close(); open.skipped = (open.skipped ?? 0) + 1;
        this.store.audit({ type: 'diary.skipped', entityId: e.id, kind: 'open', person, day: task.day, reason: 'invalid_output', revision: this.store.nextRevision(), at: now });
      }
      this.saveConsolidationState(all);
      return { status: skipped ? 'skipped' : 'invalid' };
    }
    // The same one check on what she wrote as for the private diary.
    const rejected = SENSITIVE.test(answer.text) ? 'sensitive' : null, sourceIds = answer.usedIds.map(ref => task.refs[ref]);
    let openId = null;
    if (!rejected) {
      openId = randomUUID();
      this.store.db.prepare('INSERT INTO diaries(id,entity_id,kind,status,revision,world_at,body) VALUES(?,?,?,?,?,?,?)').run(openId, e.id, 'open', 'open', this.store.nextRevision(), world.worldNow, JSON.stringify({
        v: 2, day: task.day, text: answer.text, cardId: task.cardId, personId: task.personId, taskId: input.taskId, at: now,
      }));
      for (const sourceId of sourceIds) this.store.db.prepare('INSERT INTO diary_sources(diary_id,memory_id) VALUES(?,?)').run(openId, sourceId);
    }
    close(); delete own.deferredAt;
    this.store.db.prepare('INSERT INTO diary_receipts(task_id,kind,diary_id,canonical) VALUES(?,?,?,?)').run(input.taskId, 'diary', '', encoding);
    const result = { day: task.day, kind: 'open', openId, ...(rejected ? { rejected } : {}) };
    // IDs, the day, the card, an opaque person label and counts only: no diary text, no account.
    this.store.audit({ type: 'diary.committed', entityId: e.id, ...result, person, cardId: task.cardId, sources: sourceIds.length, revision: this.store.nextRevision(), at: now });
    this.saveConsolidationState(all);
    return { status: 'committed', ...result };
  }
  /** Staging and tests only (the operator route exists only with `allowDiaryTrigger`): the running Beijing day is
   * handed out by diaryNext as if it had ended, for as many ticks as it has diaries to write. The trigger is used up
   * only by a tick, while the world runs, that finds nothing left to write for that day (a paused tick, one held back
   * by consolidation or one out of budget leaves it), or when the day ends. Production writes finished days only. */
  diaryTrigger(input = {}) {
    closed(input, ['entityId'], []);
    return this.store.transaction(() => {
      const e = this.entity(input.entityId), now = this.now(), all = this.consolidationState(), own = this.consolidationOwn(all, e.id, now);
      (own.diary ||= {}).liveDay = beijingDay(now);
      this.saveConsolidationState(all);
      return { entityId: e.id, day: own.diary.liveDay, lastDay: own.diary.lastDay ?? null };
    });
  }
}

/** The model's answer in bounded form, or null: structure, length, and `usedIds` out of what was given. `field`
 * is the diary the request was for ('private' or 'open'); the other one, if sent along, is ignored. */
function validAnswer(input, refs, field) {
  const text = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.text === 'string' && value.text.trim() && value.text.length <= DIARY.textChars && !value.text.includes('\0');
  if (!text(input[field])) return null;
  if (!Array.isArray(input.usedIds) || !input.usedIds.length || input.usedIds.length > 200 || input.usedIds.some(ref => typeof ref !== 'string' || !Object.hasOwn(refs, ref))) return null;
  return { text: input[field].text.trim(), usedIds: [...new Set(input.usedIds)] };
}
