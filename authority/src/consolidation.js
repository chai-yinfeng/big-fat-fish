// Per-person consolidation: dialogue that left a conversation's replay window is read once, one
// conversation at a time, and written back as a machine digest plus quoted fact proposals.
// The worker only carries text between Authority and the model: Authority picks the conversation,
// builds the input, validates the output and writes. One batch holds one conversation of one
// person, and everything it produces belongs to that person.
// Storage (no schema change): digests are memory_items (collection 'experiences', kind 'digest'),
// the cursor and the daily counters live under the metadata key 'consolidation', an admitted batch
// is a maintenance_tasks row (mode 'consolidation') and a commit leaves a diary_receipts row
// (kind 'consolidation') holding a hash only.
import { createHash, randomUUID } from 'node:crypto';
import { canonical, closed, enumeration, fail, identifier } from './identity.js';
import { MemoryDomain } from './memory.js';
import { SENSITIVE } from './policies.js';
import { opaquePerson, opaqueStream } from './context.js';
import { renderPersona } from '../../core/src/persona.js';

const HOUR = 3600000, DAY = 24 * HOUR, BEIJING = 8 * HOUR;
export const CONSOLIDATION = Object.freeze({
  /** Batches handed out per conversation and for the whole entity, per Beijing day. */
  perStreamPerDay: 2, perDay: 24,
  /** One batch: serialized size of its observations, the share of one observation, and their number. */
  batchChars: 4600, observationChars: 1500, batchObservations: 100,
  /** Unusable model answers for the same batch before it is skipped. */
  maxInvalid: 3,
  /** Dialogue older than this when consolidation first runs is never consolidated. */
  backfillDays: 14,
  /** Nightly routine (Beijing hours): dialogue from before today, when there are a few lines or an old one. */
  nightlyFromHour: 3, nightlyToHour: 6, nightlyObservations: 4, nightlyStaleDays: 7,
  summaryChars: 300, feelingChars: 120, facts: 4,
});
/** Proposal IDs of facts extracted by consolidation. Capabilities cannot submit under this prefix. */
export const BACKGROUND_PROPOSAL = 'cons:';
const OMITTED = '[一条内容已省略]', CUT = '…[截断]';
// A digest is machine text shown to the operator and, later, to the model: no note delimiter, no account-like number.
const UNSAFE_DIGEST = /[<＜]{3,}|[>＞]{3,}|记忆中枢附注|\d{7,}/u;

export const beijingDay = at => new Date(at + BEIJING).toISOString().slice(0, 10);
const beijingMidnight = at => Math.floor((at + BEIJING) / DAY) * DAY - BEIJING;
const beijingHour = at => new Date(at + BEIJING).getUTCHours();
const beijingMinute = at => new Date(at + BEIJING).toISOString().slice(0, 16).replace('T', ' ');
const streamKey = (capabilityId, streamId) => `${capabilityId}\u0000${streamId}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
/** Characters one observation takes in the worker's request (a JSON row of ref, speaker, time and text). */
const rowChars = text => JSON.stringify(text).length + 34;
const bounded = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0');

export class ConsolidationDomain extends MemoryDomain {
  consolidationState() {
    const row = this.store.db.prepare("SELECT value FROM metadata WHERE key='consolidation'").get();
    return row ? JSON.parse(row.value) : {};
  }
  #save(all) {
    this.store.db.prepare("INSERT INTO metadata(key,value) VALUES('consolidation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(all));
  }
  /** This entity's state for today (Beijing): the daily counters start again on a new day. */
  #today(all, entityId, now) {
    const own = all[entityId] ||= { since: now - CONSOLIDATION.backfillDays * DAY, day: '', calls: 0, streams: {} }, day = beijingDay(now);
    if (own.day !== day) { own.day = day; own.calls = 0; for (const stream of Object.values(own.streams)) stream.calls = 0; }
    return own;
  }
  #privateStreams(entityId) {
    return this.store.db.prepare("SELECT capability_id AS capabilityId,stream_id AS streamId,person_id AS personId FROM streams WHERE entity_id=? AND audience='private' ORDER BY capability_id,stream_id").all(entityId);
  }
  #cursorRow(state) {
    return state?.lastObservationId ? this.store.db.prepare('SELECT rowid FROM observations WHERE id=?').get(state.lastObservationId)?.rowid ?? 0 : 0;
  }
  /** The observations after a conversation's cursor (at most 400): `leading(before)` are the first ones older
   * than a time, `rolledOut` the completed runs the executor no longer replays, `silent(row)` tells a row with
   * nothing to read. */
  #after(stream, state, since) {
    const rows = this.store.db.prepare('SELECT id,body,forgotten FROM observations WHERE capability_id=? AND stream_id=? AND rowid>? ORDER BY rowid LIMIT 400')
      .all(stream.capabilityId, stream.streamId, this.#cursorRow(state)).map(row => ({ id: row.id, ...JSON.parse(row.body), forgotten: Boolean(row.forgotten) }));
    // Nothing to read: forgotten, older than the backfill bound, or not a line of this dialogue.
    const silent = row => row.forgotten || row.at < since || !['user', 'assistant'].includes(row.role) || !row.text;
    const leading = before => { const end = rows.findIndex(row => !(row.at < before)); return rows.slice(0, end < 0 ? rows.length : end); };
    // The window starts at a run's stored timestamp, taken after that run's own message was observed
    // and before its reply was: the lines before it end with the previous run's reply. A trailing line
    // of the person is the first replayed run's (or one never answered) and stays for a later batch.
    const rollout = this.windows.get(streamKey(stream.capabilityId, stream.streamId)), rolledOut = rollout === undefined ? [] : leading(rollout);
    while (rolledOut.length && rolledOut.at(-1).role === 'user') rolledOut.pop();
    return { silent, leading, rolledOut };
  }
  /** The next batch of one conversation, or null: the leading observations after the cursor that are
   * out of the replay window (`rollout`) or, in the nightly hours, from before today. */
  #batch(stream, state, since, now) {
    const { silent, leading, rolledOut } = this.#after(stream, state, since);
    let trigger = 'rollout', taken = rolledOut;
    if (!taken.some(row => !silent(row))) {
      const hour = beijingHour(now), old = hour >= CONSOLIDATION.nightlyFromHour && hour < CONSOLIDATION.nightlyToHour ? leading(beijingMidnight(now)) : [], spoken = old.filter(row => !silent(row));
      if (spoken.length >= CONSOLIDATION.nightlyObservations || spoken.some(row => row.at < now - CONSOLIDATION.nightlyStaleDays * DAY)) { trigger = 'nightly'; taken = old; }
    }
    if (!taken.length) return null;
    const batch = []; let chars = 0, shown = 0;
    for (const row of taken) {
      if (silent(row)) { batch.push({ id: row.id }); continue; }
      const omitted = SENSITIVE.test(row.text), text = omitted ? OMITTED : row.text.length > CONSOLIDATION.observationChars ? row.text.slice(0, CONSOLIDATION.observationChars - CUT.length) + CUT : row.text;
      if (shown && (chars + rowChars(text) > CONSOLIDATION.batchChars || shown >= CONSOLIDATION.batchObservations)) break;
      chars += rowChars(text); shown++;
      batch.push({ id: row.id, ref: 'o' + shown, role: row.role, at: row.at, text, omitted });
    }
    return { trigger, batch };
  }
  /** Maintenance credential only. Picks the conversation itself; the caller cannot name one. */
  consolidationNext(entityId, input = {}) {
    closed(input, [], []);
    return this.store.transaction(() => {
      const e = this.entity(entityId), world = this.worldStatus(), now = this.now();
      if (world.paused) return { entityId: e.id, task: null, reason: 'paused' };
      const all = this.consolidationState(), own = this.#today(all, e.id, now);
      let task = null, reason = 'idle';
      const streams = this.#privateStreams(e.id).map(stream => ({ stream, key: streamKey(stream.capabilityId, stream.streamId) }))
        .sort((a, b) => (own.streams[a.key]?.calls ?? 0) - (own.streams[b.key]?.calls ?? 0));
      for (const { stream, key } of streams) {
        const state = own.streams[key] ||= { calls: 0 };
        // A batch nobody spoke in (forgotten, too old, only her side) moves the cursor without a model call.
        let found = this.#batch(stream, state, own.since, now);
        for (let guard = 0; found && !found.batch.some(row => row.role === 'user' && !row.omitted) && guard < 8; guard++) {
          state.lastObservationId = found.batch.at(-1).id;
          found = this.#batch(stream, state, own.since, now);
        }
        if (!found || !found.batch.some(row => row.role === 'user' && !row.omitted)) continue;
        if (own.calls >= CONSOLIDATION.perDay || state.calls >= CONSOLIDATION.perStreamPerDay) { reason = 'budget'; continue; }
        const shown = found.batch.filter(row => row.ref), epoch = this.streamEpoch(e, stream.capabilityId, stream.streamId), base = state.lastObservationId ?? null, ids = found.batch.map(row => row.id);
        const taskId = sha256(canonical({ entityId: e.id, capabilityId: stream.capabilityId, streamId: stream.streamId, base, ids, epoch, worldRevision: world.revision }));
        this.store.db.prepare('INSERT OR IGNORE INTO maintenance_tasks(id,entity_id,epoch,cursor,world_revision,mode,source_ids) VALUES(?,?,?,?,?,?,?)').run(taskId, e.id, epoch, 0, world.revision, 'consolidation', JSON.stringify({
          capabilityId: stream.capabilityId, streamId: stream.streamId, base, ids, refs: Object.fromEntries(shown.filter(row => !row.omitted).map(row => [row.ref, row.id])),
        }));
        // Counted when handed out: a worker that dies after the model call has still spent it.
        own.calls++; state.calls++; state.issued = taskId; own.lastIssuedAt = now;
        const facts = this.store.db.prepare("SELECT DISTINCT json_extract(body,'$.key') AS key FROM memory_items WHERE entity_id=? AND collection='facts' AND person_id=? AND status='active' ORDER BY revision DESC LIMIT 64").all(e.id, stream.personId);
        const knownKeys = []; let keyChars = 0;
        for (const { key: name } of facts) if (typeof name === 'string' && keyChars + name.length + 1 <= 400) { knownKeys.push(name); keyChars += name.length + 1; }
        const last = this.store.db.prepare("SELECT body FROM memory_items WHERE entity_id=? AND person_id=? AND kind='digest' AND status='active' AND json_extract(body,'$.streamId')=? ORDER BY revision DESC LIMIT 1").get(e.id, stream.personId, stream.streamId);
        task = {
          taskId, trigger: found.trigger,
          personaText: renderPersona({ ...JSON.parse(e.persona), userCallName: '你', relationshipStage: 'new' }).slice(0, 1000),
          knownKeys, lastDigest: last ? String(JSON.parse(last.body).summary ?? '').slice(0, CONSOLIDATION.summaryChars) : '',
          // Short refs and Beijing minutes only: no observation, stream or person ID leaves Authority here.
          observations: shown.map(row => ({ ref: row.ref, role: row.role, time: beijingMinute(row.at), text: row.text })),
        };
        break;
      }
      this.#save(all);
      return task ? { entityId: e.id, task } : { entityId: e.id, task: null, reason };
    });
  }
  /** Maintenance credential only. `outcome`: 'ok' with the model's answer, 'invalid' (unusable answer)
   * or 'deferred' (the gateway's spend tier refused the call: the reservation is returned). */
  consolidationCommit(entityId, input) {
    closed(input, ['taskId', 'outcome', 'digest', 'facts'], ['taskId', 'outcome']);
    identifier(input.taskId);
    enumeration(input.outcome, ['ok', 'invalid', 'deferred']);
    const encoding = sha256(canonical(input));
    return this.store.transaction(() => {
      const e = this.entity(entityId), world = this.worldStatus(), now = this.now();
      const done = this.store.db.prepare("SELECT diary_id,canonical FROM diary_receipts WHERE task_id=? AND kind='consolidation'").get(input.taskId);
      if (done) {
        if (done.canonical !== encoding) fail('CONFLICT', 'Consolidation retry changed content', 409);
        return { status: 'committed', digestId: done.diary_id || null, replayed: true };
      }
      const row = this.store.db.prepare("SELECT * FROM maintenance_tasks WHERE id=? AND entity_id=? AND mode='consolidation'").get(input.taskId, e.id);
      if (!row || world.paused || row.world_revision !== world.revision) fail('CONFLICT', 'Consolidation batch is no longer current', 409);
      const task = JSON.parse(row.source_ids), key = streamKey(task.capabilityId, task.streamId);
      const stream = this.store.db.prepare("SELECT person_id AS personId FROM streams WHERE capability_id=? AND stream_id=? AND entity_id=? AND audience='private'").get(task.capabilityId, task.streamId, e.id);
      const all = this.consolidationState(), own = this.#today(all, e.id, now), state = own.streams[key];
      if (!stream || !state || (state.lastObservationId ?? null) !== task.base || row.epoch !== this.streamEpoch(e, task.capabilityId, task.streamId)) fail('CONFLICT', 'Consolidation batch is no longer current', 409);
      const label = { stream: opaqueStream(task.capabilityId, task.streamId), person: opaquePerson(stream.personId) };
      const advance = () => {
        state.lastObservationId = task.ids.at(-1); state.invalid = 0; delete state.issued;
        this.store.db.prepare("DELETE FROM maintenance_tasks WHERE entity_id=? AND mode='consolidation' AND json_extract(source_ids,'$.capabilityId')=? AND json_extract(source_ids,'$.streamId')=?").run(e.id, task.capabilityId, task.streamId);
      };
      const answer = input.outcome === 'ok' ? validAnswer(input) : null;
      if (input.outcome === 'deferred') {
        // Only the batch that is out: a repeated report returns nothing twice.
        if (state.issued === input.taskId) { own.calls = Math.max(0, own.calls - 1); state.calls = Math.max(0, state.calls - 1); delete state.issued; }
        own.deferredAt = now;
        this.#save(all);
        return { status: 'deferred' };
      }
      if (!answer) {
        if (state.issued === input.taskId) { state.invalid = (state.invalid ?? 0) + 1; delete state.issued; }
        const skipped = state.invalid >= CONSOLIDATION.maxInvalid;
        if (skipped) {
          advance(); state.skipped = (state.skipped ?? 0) + 1;
          this.store.audit({ type: 'consolidation.skipped', entityId: e.id, ...label, observations: task.ids.length, reason: 'invalid_output', revision: this.store.nextRevision(), at: now });
        }
        this.#save(all);
        return { status: skipped ? 'skipped' : 'invalid' };
      }
      const shown = Object.values(task.refs).map(id => this.store.db.prepare('SELECT id,body,forgotten FROM observations WHERE id=?').get(id)).filter(source => source && !source.forgotten).map(source => ({ id: source.id, at: JSON.parse(source.body).at }));
      const written = `${answer.summary}\n${answer.feeling}`;
      const digestRejected = SENSITIVE.test(written) ? 'sensitive' : UNSAFE_DIGEST.test(written) ? 'unsafe_text' : !shown.length ? 'sources_forgotten' : null;
      const revision = this.store.nextRevision();
      let digestId = null;
      if (!digestRejected) {
        digestId = randomUUID();
        const toAt = Math.max(...shown.map(source => source.at));
        // No `evidence`: a digest is a paraphrase. Its sources are `derivedFrom` (forgetting one of them removes
        // the digest, see forgetPreview); it never joins the evidence closure and is never evidence itself.
        this.store.insertMemory(e.id, 'experiences', {
          id: digestId, personId: stream.personId, visibility: 'private', kind: 'digest', via: 'consolidation',
          summary: answer.summary, ...(answer.feeling ? { feeling: answer.feeling } : {}),
          derivedFrom: shown.map(source => source.id), fromAt: Math.min(...shown.map(source => source.at)), toAt, eventAt: toAt,
          capabilityId: task.capabilityId, streamId: task.streamId, taskId: input.taskId, scope: { kind: 'person' }, revision, at: now,
        }, world.worldNow);
        state.digests = (state.digests ?? 0) + 1;
      }
      // Facts go through the ordinary inbox and review(): the quote must be this person's own words, verbatim.
      const policy = this.store.db.prepare('SELECT policy FROM capabilities WHERE id=?').get(task.capabilityId).policy, proposals = [], dropped = [];
      answer.facts.forEach((fact, index) => {
        const observationId = task.refs[fact.ref];
        if (!observationId) { dropped.push({ index, reason: 'ref_unavailable' }); return; }
        const proposal = { proposalId: `${BACKGROUND_PROPOSAL}${input.taskId.slice(0, 24)}:${index}`, observationId, type: 'fact.report', payload: { key: fact.key, value: fact.value, quote: fact.quote } };
        this.store.db.prepare('INSERT INTO inbox(capability_id,proposal_id,observation_id,canonical,body,policy,status,receipt,entity_id) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(task.capabilityId, proposal.proposalId, observationId, canonical(proposal), JSON.stringify(proposal), policy, 'pending', JSON.stringify({ proposalId: proposal.proposalId, status: 'pending', policy }), e.id);
        proposals.push(proposal.proposalId);
      });
      advance(); state.lastAt = now; own.lastCommittedAt = now; delete own.deferredAt;
      this.store.db.prepare('INSERT INTO diary_receipts(task_id,kind,diary_id,canonical) VALUES(?,?,?,?)').run(input.taskId, 'consolidation', digestId ?? '', encoding);
      // IDs, labels and counts only: no dialogue, digest or fact text.
      this.store.audit({ type: 'consolidation.committed', entityId: e.id, ...label, observations: task.ids.length, digestId, ...(digestRejected ? { digestRejected } : {}), proposals, dropped, revision, at: now });
      this.#save(all);
      return { status: 'committed', digestId, ...(digestRejected ? { digestRejected } : {}), proposals, dropped };
    });
  }
  /** Operator-only, read-only: counters, per-conversation backlog (opaque labels) and leftovers. No text. */
  consolidationStatus(input = {}) {
    closed(input, ['entityId'], []);
    const e = this.entity(input.entityId), now = this.now(), day = beijingDay(now), own = this.consolidationState()[e.id];
    const today = own?.day === day, since = own?.since ?? now - CONSOLIDATION.backfillDays * DAY;
    const streams = this.#privateStreams(e.id).map(stream => {
      const state = own?.streams[streamKey(stream.capabilityId, stream.streamId)];
      const behind = this.store.db.prepare("SELECT COUNT(*) AS observations,COALESCE(SUM(LENGTH(json_extract(body,'$.text'))),0) AS chars FROM observations WHERE capability_id=? AND stream_id=? AND rowid>? AND forgotten=0 AND json_extract(body,'$.at')>=?")
        .get(stream.capabilityId, stream.streamId, this.#cursorRow(state), since);
      const { silent, rolledOut } = this.#after(stream, state, since);
      // `behind`: everything not consolidated yet, the live window included; `waiting`: what has already left the window.
      return { stream: opaqueStream(stream.capabilityId, stream.streamId), person: opaquePerson(stream.personId), owner: stream.personId === 'person:owner', behind, waiting: rolledOut.filter(row => !silent(row)).length, calls: today ? state?.calls ?? 0 : 0, digests: state?.digests ?? 0, skipped: state?.skipped ?? 0, lastAt: state?.lastAt ?? null };
    });
    const deferredAt = own?.deferredAt ?? null, calls = today ? own.calls : 0;
    return {
      entityId: e.id, day, timezone: 'Asia/Shanghai', calls, limits: { perDay: CONSOLIDATION.perDay, perStreamPerDay: CONSOLIDATION.perStreamPerDay },
      since, lastIssuedAt: own?.lastIssuedAt ?? null, lastCommittedAt: own?.lastCommittedAt ?? null, deferredAt,
      // Why nothing is being handed out now, if so: the spend tier refused a call today and none has gone through since
      // (`deferredAt`), or today's batches are used up.
      paused: deferredAt !== null && beijingDay(deferredAt) === day ? 'spend' : calls >= CONSOLIDATION.perDay ? 'daily' : null,
      streams,
      // What review() made of the facts consolidation extracted, by its own reason codes.
      extracted: this.store.db.prepare("SELECT status,json_extract(receipt,'$.reason') AS reason,COUNT(*) AS n FROM inbox WHERE entity_id=? AND proposal_id LIKE 'cons:%' GROUP BY status,reason").all(e.id)
        .reduce((counts, row) => { if (row.status === 'rejected') counts.rejected[row.reason ?? 'unknown'] = row.n; else counts[row.status] = row.n; return counts; }, { accepted: 0, pending: 0, rejected: {} }),
      // Digests that still cover a forgotten observation (an older release forgot it without the cascade).
      staleDigestIds: this.store.db.prepare("SELECT DISTINCT m.id FROM memory_items m,json_each(m.body,'$.derivedFrom') j JOIN observations o ON o.id=j.value WHERE m.entity_id=? AND m.kind='digest' AND o.forgotten=1").all(e.id).map(row => row.id),
    };
  }
  /** Operator-only, read on request: the observations one item was made from (a digest's `derivedFrom`,
   * otherwise its evidence). Private evidence: never part of a listing. */
  memorySources(input) {
    closed(input, ['entityId', 'id'], ['id']);
    identifier(input.id);
    const e = this.entity(input.entityId), row = this.store.db.prepare('SELECT * FROM memory_items WHERE entity_id=? AND id=?').get(e.id, input.id);
    if (!row) fail('NOT_FOUND', 'Memory not found', 404);
    const body = JSON.parse(row.body);
    const ids = Array.isArray(body.derivedFrom) ? body.derivedFrom : this.store.db.prepare('SELECT observation_id FROM memory_sources WHERE memory_id=?').all(row.id).map(source => source.observation_id);
    return {
      entityId: e.id, id: row.id, machine: row.kind === 'digest',
      sources: ids.slice(0, 200).map(id => this.store.db.prepare('SELECT id,body,forgotten FROM observations WHERE id=? AND entity_id=?').get(id, e.id)).filter(Boolean).map(source => {
        const observation = JSON.parse(source.body);
        return { id: source.id, role: observation.role, at: observation.at, text: source.forgotten ? '' : observation.text, forgotten: Boolean(source.forgotten) };
      }),
    };
  }
}

/** The model's answer in bounded form, or null: an answer out of shape is an unusable one, not a protocol error. */
function validAnswer(input) {
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const { digest, facts = [] } = input;
  if (!plain(digest) || Object.keys(digest).some(name => !['summary', 'feeling'].includes(name)) || !bounded(digest.summary, CONSOLIDATION.summaryChars)) return null;
  if (digest.feeling !== undefined && (typeof digest.feeling !== 'string' || digest.feeling.length > CONSOLIDATION.feelingChars || digest.feeling.includes('\0'))) return null;
  if (!Array.isArray(facts) || facts.length > CONSOLIDATION.facts) return null;
  for (const fact of facts) {
    if (!plain(fact) || Object.keys(fact).length !== 4 || !bounded(fact.key, 128) || !bounded(fact.value, 1000) || !bounded(fact.quote, 2000) || typeof fact.ref !== 'string' || !/^o\d{1,3}$/.test(fact.ref)) return null;
  }
  return { summary: digest.summary.trim(), feeling: (digest.feeling ?? '').trim(), facts };
}
