// Initiated runs: a turn she starts in one person's private conversation when that person has sent nothing.
// A request is registered here, fetched by the QQ bridge (which can name no conversation or person:
// Authority picks, as with consolidation), run in that conversation's own queue and reported back once.
// A request that cannot go out is closed with the reason, never kept for later: nothing is sent after a
// pause, in the quiet hours or once the person has spoken, and a request that went out is never handed out
// again, whatever became of it.
// The only source in this release is the operator's "try it on me", and the only conversation a request may
// name is the owner's own private QQ conversation.
// Storage (no schema change): everything lives under the metadata key 'initiations': the requests and, once the
// operator has changed them, the quiet hours.
import { randomUUID } from 'node:crypto';
import { capability, closed, fail, identifier } from './identity.js';
import { ConsolidationDomain } from './consolidation.js';
import { opaquePerson } from './context.js';

const MINUTE = 60000, BEIJING = 8 * 3600000;
export const INITIATION = Object.freeze({
  /** A request nobody fetched within this time is void (the bridge asks about once a minute while QQ is up). */
  ttlMs: 5 * MINUTE,
  /** A fetched request the bridge never reported on is closed as `unknown` after this (a run takes at most 10 minutes). */
  reportMs: 20 * MINUTE,
  /** Default quiet hours, Beijing wall clock, from 23:30 until 08:00: nothing is initiated. */
  quiet: Object.freeze({ fromMinute: 23 * 60 + 30, toMinute: 8 * 60 }),
  /** Closed requests kept for the operator's list. */
  kept: 50,
});
/** How a fetched request may end, as the bridge reports it; besides these, `dropped:<reason>`. */
export const INITIATION_OUTCOMES = Object.freeze(['sent', 'partial', 'unknown', 'failed', 'declined', 'deferred:budget']);
const DROPPED = /^dropped:[a-z_]{1,32}$/;
const OWNER = 'person:owner', CAPABILITY = 'qq';

/** Is `at` inside the quiet hours (minutes of the Beijing day; a window may pass midnight; equal ends mean none)? */
export function quietHours(at, { fromMinute, toMinute } = INITIATION.quiet) {
  const minute = Math.floor((at + BEIJING) / MINUTE) % 1440;
  return fromMinute < toMinute ? minute >= fromMinute && minute < toMinute : fromMinute > toMinute && (minute >= fromMinute || minute < toMinute);
}
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const validMinute = value => Number.isInteger(value) && value >= 0 && value < 1440;

export class InitiationDomain extends ConsolidationDomain {
  #state() {
    const row = this.store.db.prepare("SELECT value FROM metadata WHERE key='initiations'").get();
    return row ? JSON.parse(row.value) : { items: [] };
  }
  #save(state) {
    const closedItems = state.items.filter(item => item.status === 'closed');
    const dropped = new Set(closedItems.slice(0, Math.max(0, closedItems.length - INITIATION.kept)));
    state.items = state.items.filter(item => !dropped.has(item));
    this.store.db.prepare("INSERT INTO metadata(key,value) VALUES('initiations',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(state));
  }
  /** The quiet hours in force: the operator's, else the default. */
  #quiet(state) { return validMinute(state.quiet?.fromMinute) && validMinute(state.quiet.toMinute) ? state.quiet : INITIATION.quiet; }
  #close(item, outcome, now) { item.status = 'closed'; item.outcome = outcome; item.endedAt = now; }
  /** Closes what can no longer go out: a waiting request that is refused now, and a fetched request without a
   * report (its delivery is unknown, and it is never handed out again). */
  #settle(state, world, now) {
    for (const item of state.items) {
      if (item.status === 'issued' && now - item.issuedAt >= INITIATION.reportMs) { this.#close(item, 'unknown', now); item.unreported = true; }
      else if (item.status === 'waiting') { const refusal = this.#refusal(item, world, now, this.#quiet(state)); if (refusal) this.#close(item, refusal, now); }
    }
  }
  /** The owner's own private QQ conversation, from the owner's newest QQ binding; null when there is none. */
  #ownerStream() {
    const match = this.store.db.prepare('SELECT actor_id AS actorId FROM actors WHERE capability_id=? AND person_id=? ORDER BY rowid DESC').all(CAPABILITY, OWNER)
      .map(row => /^qq:([1-9]\d{0,19}):user:([1-9]\d{0,19})$/.exec(row.actorId)).find(Boolean);
    if (!match) return null;
    const streamId = `qq:${match[1]}:private:${match[2]}`;
    const stream = this.store.db.prepare('SELECT person_id AS personId,audience,entity_id AS entityId FROM streams WHERE capability_id=? AND stream_id=?').get(CAPABILITY, streamId);
    return stream && stream.personId === OWNER && stream.audience === 'private' ? { streamId, entityId: stream.entityId } : null;
  }
  /** Why a waiting request may not go out now (`dropped:<reason>`), or null. */
  #refusal(item, world, now, quiet) {
    // Paused now, or paused and resumed since it was registered: nothing is made up for afterwards.
    if (world.paused || world.revision !== item.worldRevision) return 'dropped:paused';
    if (now >= item.expiresAt) return 'dropped:expired';
    // This release initiates towards the owner only, in the owner's current private conversation.
    const target = this.#ownerStream();
    if (item.capabilityId !== CAPABILITY || item.personId !== OWNER || !target || target.streamId !== item.streamId || target.entityId !== item.entityId) return 'dropped:target';
    if (this.streamEpoch(this.entity(item.entityId), item.capabilityId, item.streamId) !== item.memoryEpoch) return 'dropped:epoch';
    if (quietHours(now, quiet)) return 'dropped:quiet_hours';
    // The person has spoken since: their message gets an ordinary reply instead.
    if (this.store.db.prepare("SELECT 1 FROM observations WHERE capability_id=? AND stream_id=? AND rowid>? AND json_extract(body,'$.role')='user' LIMIT 1").get(item.capabilityId, item.streamId, item.afterRow)) return 'dropped:person_spoke';
    return null;
  }
  #view(item) {
    return { id: item.id, kind: item.kind, source: item.source, person: opaquePerson(item.personId), owner: item.personId === OWNER, status: item.status, outcome: item.outcome ?? null, createdAt: item.createdAt, issuedAt: item.issuedAt ?? null, endedAt: item.endedAt ?? null };
  }
  /** Operator only: one initiated run towards the owner's own private QQ conversation. The request takes no
   * argument, so it can name nobody else. One request is open at a time; a request that may not go out now is
   * recorded closed with the reason. */
  initiationPoke(input = {}) {
    closed(input, [], []);
    return this.store.transaction(() => {
      const state = this.#state(), world = this.worldStatus(), now = this.now();
      this.#settle(state, world, now);
      const target = this.#ownerStream();
      if (!target) fail('CONFLICT', 'Bind the owner before initiating', 409);
      const open = state.items.find(item => item.status !== 'closed');
      if (open) { this.#save(state); return { ...this.#view(open), already: true }; }
      const item = {
        id: randomUUID(), kind: 'proactive', source: 'poke', capabilityId: CAPABILITY, streamId: target.streamId, personId: OWNER, entityId: target.entityId,
        memoryEpoch: this.streamEpoch(this.entity(target.entityId), CAPABILITY, target.streamId), worldRevision: world.revision,
        afterRow: this.store.db.prepare('SELECT MAX(rowid) AS n FROM observations').get().n ?? 0, createdAt: now, expiresAt: now + INITIATION.ttlMs, status: 'waiting',
      };
      const refusal = this.#refusal(item, world, now, this.#quiet(state));
      if (refusal) this.#close(item, refusal, now);
      state.items.push(item);
      this.#save(state);
      return this.#view(item);
    });
  }
  /** QQ capability credential only. Authority picks: the caller can name no conversation, person or request.
   * At most one request is out at a time. */
  initiationNext(capabilityId, input = {}) {
    closed(input, [], []);
    if (capabilityId !== CAPABILITY || capability(this.store, capabilityId).policy !== 'conversation.v1') fail('FORBIDDEN', 'Initiations are QQ-only', 403);
    return this.store.transaction(() => {
      const state = this.#state(), stored = JSON.stringify(state), world = this.worldStatus(), now = this.now();
      this.#settle(state, world, now);
      let initiation = null, reason = world.paused ? 'paused' : 'idle';
      if (state.items.some(item => item.status === 'issued')) reason = 'busy';
      else {
        const item = state.items.find(entry => entry.status === 'waiting');
        if (item) {
          item.status = 'issued'; item.issuedAt = now;
          initiation = { id: item.id, kind: item.kind, streamId: item.streamId, memoryEpoch: item.memoryEpoch, expiresAt: item.expiresAt };
        }
      }
      // An idle poll writes nothing.
      if (JSON.stringify(state) !== stored) this.#save(state);
      return initiation ? { initiation } : { initiation: null, reason };
    });
  }
  /** QQ capability credential only: how a fetched request ended. Reported once; the same report again changes
   * nothing, a different one is refused (except over a request closed for want of any report). */
  initiationAck(capabilityId, input) {
    closed(input, ['id', 'outcome']);
    identifier(input.id);
    if (typeof input.outcome !== 'string' || !(INITIATION_OUTCOMES.includes(input.outcome) || DROPPED.test(input.outcome))) fail('VALIDATION_ERROR', 'Unsupported initiation outcome');
    if (capabilityId !== CAPABILITY || capability(this.store, capabilityId).policy !== 'conversation.v1') fail('FORBIDDEN', 'Initiations are QQ-only', 403);
    return this.store.transaction(() => {
      const state = this.#state(), now = this.now(), item = state.items.find(entry => entry.id === input.id);
      if (!item || item.capabilityId !== capabilityId || item.status === 'waiting') fail('CONFLICT', 'Initiation is not out', 409);
      if (item.status === 'closed') {
        if (item.outcome === input.outcome) return { status: 'recorded', replayed: true };
        if (!item.unreported) fail('CONFLICT', 'Initiation was already reported', 409);
      }
      this.#close(item, input.outcome, now); delete item.unreported;
      // The gateway's spend tier refused the run (it stops this kind of work first): recorded, nothing is retried.
      if (input.outcome === 'deferred:budget') state.deferredAt = now;
      this.#save(state);
      return { status: 'recorded' };
    });
  }
  /** Operator only: the newest requests and how each ended. Opaque labels and times, no text, no account.
   * Reading it also closes what can no longer go out, so the list never shows a dead request as waiting. */
  initiationLog() {
    return this.store.transaction(() => {
      const state = this.#state(), stored = JSON.stringify(state), now = this.now();
      this.#settle(state, this.worldStatus(), now);
      if (JSON.stringify(state) !== stored) this.#save(state);
      const quiet = this.#quiet(state);
      return {
        quietHours: { from: clock(quiet.fromMinute), to: clock(quiet.toMinute), timezone: 'Asia/Shanghai', now: quietHours(now, quiet) }, deferredAt: state.deferredAt ?? null,
        items: state.items.map(item => this.#view(item)).reverse(),
      };
    });
  }
  /** Operator only: the quiet hours as Beijing wall-clock times `{quietHours:{from:'HH:MM',to:'HH:MM'}}`; equal
   * ends mean no quiet hours. No console form uses it yet: scenario replay does, to run at any hour. */
  initiationSettings(input) {
    closed(input, ['quietHours']); closed(input.quietHours, ['from', 'to']);
    const minutes = ['from', 'to'].map(key => { const match = typeof input.quietHours[key] === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.quietHours[key]) : null; if (!match) fail('VALIDATION_ERROR', 'Quiet hours are HH:MM'); return Number(match[1]) * 60 + Number(match[2]); });
    return this.store.transaction(() => {
      const state = this.#state();
      state.quiet = { fromMinute: minutes[0], toMinute: minutes[1] };
      this.#save(state);
      return { quietHours: { from: clock(minutes[0]), to: clock(minutes[1]), timezone: 'Asia/Shanghai', now: quietHours(this.now(), state.quiet) } };
    });
  }
}
