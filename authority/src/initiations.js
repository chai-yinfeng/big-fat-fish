// Initiated runs: a turn she starts in one person's private conversation when that person has sent nothing.
// A request is registered here, fetched by the bridge of the channel it is for (which can name no conversation
// or person: Authority picks, as with consolidation), run in that conversation's own queue and reported back once.
// Which channel: the private conversation in which that person last spoke. A bridge is only ever handed requests
// of its own channel (the capability of the credential it calls with) and can only report on those.
// A request that cannot go out is closed with the reason, never kept for later: nothing is sent after a
// pause, in the quiet hours or once the person has spoken, and a request that went out is never handed out
// again, whatever became of it.
// Two kinds, each with its own rule for whom it may reach:
// - `proactive`: she decides to speak. The only source in this release is the operator's "try it on me", and the
//   only conversation such a request may name is the owner's own private conversation (the one they last spoke in).
// - `completion`: a background job of the content service finished (capabilities/media/jobs.js). It goes to the
//   conversation the job was registered in and to nobody else: the job record names it, Authority checks it against
//   its own bindings every time, and neither the bridge nor the model can name another. A finished job is told
//   once: in a turn she starts, or with the person's next message (`carried`), never both and never again.
// Storage (no schema change): everything lives under the metadata key 'initiations': the requests and, once the
// operator has changed them, the quiet hours.
// A third kind is handed out through the same `next` and reported through the same `ack`, and reaches nobody:
// - `wake`: her private wake-up (wake.js). It runs in her own conversation, sends nothing, and is kept apart from the
//   requests above (metadata keys 'initiative' and 'initiative.log').
import { randomUUID } from 'node:crypto';
import { capability, closed, fail, identifier } from './identity.js';
import { OpenDiaryDomain } from './open-diary.js';
import { opaquePerson } from './context.js';
import { roomProjection } from './room.js';
import { DEFAULT_CARD_ID } from './cards.js';
import { OUTREACH_TIERS, SELECTION, SELF_PERSON, WAKE, WAKE_OUTCOMES, afterQuiet, beijingDay, beijingMidnight, candidateWeights, nextDay, pick, refusedText, regularNext, renderBriefing, selfStream } from './wake.js';

const MINUTE = 60000, BEIJING = 8 * 3600000;
export const INITIATION = Object.freeze({
  /** A request nobody fetched within this time is void (the bridge asks about once a minute while its platform is up). */
  ttlMs: 5 * MINUTE,
  /** A fetched request the bridge never reported on is closed as `unknown` after this (a run takes at most 10 minutes). */
  reportMs: 20 * MINUTE,
  /** Default quiet hours, Beijing wall clock, from 23:30 until 08:00: nothing is initiated. */
  quiet: Object.freeze({ fromMinute: 23 * 60 + 30, toMinute: 8 * 60 }),
  /** Closed requests kept for the operator's list. */
  kept: 50,
  /** She may start a turn about a finished job this long after it ended; later it only rides on the person's next message. */
  completionMs: 120 * MINUTE,
  /** In the quiet hours a finished job is still told when the person wrote within this time; otherwise it waits for their next message. */
  recentMs: 10 * MINUTE,
});
/** How a fetched request may end, as the bridge reports it; besides these, `dropped:<reason>`. */
export const INITIATION_OUTCOMES = Object.freeze(['sent', 'partial', 'unknown', 'failed', 'declined', 'deferred:budget', 'carried']);
/** A finished job with one of these outcomes is settled: she was told (or may have been), or it can never be told.
 * Any other outcome means nothing reached her or the person, and the result still rides on the person's next message. */
const SETTLED = ['sent', 'partial', 'unknown', 'declined', 'carried', 'dropped:target', 'dropped:epoch', 'dropped:forgotten'];
const validJob = job => job !== null && typeof job === 'object' && typeof job.id === 'string' && /^job:[a-f0-9-]{36}$/.test(job.id) && Number.isSafeInteger(job.endedAt) && Number.isSafeInteger(job.expiresAt) && job.scope !== null && typeof job.scope === 'object';
const DROPPED = /^dropped:[a-z_]{1,32}$/;
const OWNER = 'person:owner';

/** Is `at` inside the quiet hours (minutes of the Beijing day; a window may pass midnight; equal ends mean none)? */
export function quietHours(at, { fromMinute, toMinute } = INITIATION.quiet) {
  const minute = Math.floor((at + BEIJING) / MINUTE) % 1440;
  return fromMinute < toMinute ? minute >= fromMinute && minute < toMinute : fromMinute > toMinute && (minute >= fromMinute || minute < toMinute);
}
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const validMinute = value => Number.isInteger(value) && value >= 0 && value < 1440;

export class InitiationDomain extends OpenDiaryDomain {
  // What the content service is to be told about its finished jobs (handed out, settled, carry-only). The transport
  // drains it after each call; a report that is lost is made again when the job is next listed.
  #notices = [];
  drainJobNotices() { return this.#notices.splice(0); }
  #state() {
    const row = this.store.db.prepare("SELECT value FROM metadata WHERE key='initiations'").get();
    return row ? JSON.parse(row.value) : { items: [] };
  }
  #save(state) {
    // A settled completion stays as long as its job may still be listed: that record is what forbids a second telling.
    const now = this.now(), closedItems = state.items.filter(item => item.status === 'closed' && !(item.jobRef && item.keepUntil > now));
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
      if (item.status === 'issued' && now - item.issuedAt >= INITIATION.reportMs) { this.#close(item, 'unknown', now); item.unreported = true; if (item.jobRef) this.#notices.push({ id: item.jobRef, state: 'closed', outcome: 'unknown' }); }
      else if (item.status === 'waiting') { const refusal = this.#refusal(item, world, now, this.#quiet(state)); if (refusal) this.#close(item, refusal, now); }
    }
  }
  /** The private conversation a person is to be reached in: the one, on any conversation channel where an account
   * of theirs is still bound, in which they last spoke (by Authority's own order of arrival); if they never spoke,
   * the one bound last. Null when there is none. */
  #recentStream(personId) {
    return this.store.db.prepare(`SELECT s.capability_id AS capabilityId,s.stream_id AS streamId,s.entity_id AS entityId,
      (SELECT MAX(o.rowid) FROM observations o WHERE o.capability_id=s.capability_id AND o.stream_id=s.stream_id AND json_extract(o.body,'$.role')='user') AS spoke
      FROM streams s JOIN capabilities c ON c.id=s.capability_id AND c.policy='conversation.v1'
      WHERE s.person_id=? AND s.audience='private' AND EXISTS (SELECT 1 FROM actors a WHERE a.capability_id=s.capability_id AND a.person_id=s.person_id)
      ORDER BY spoke IS NULL,spoke DESC,s.rowid DESC LIMIT 1`).get(personId) ?? null;
  }
  /** Why a waiting request may not go out now (`dropped:<reason>`), or null. */
  #refusal(item, world, now, quiet) {
    // Paused now, or paused and resumed since it was registered: nothing is made up for afterwards.
    if (world.paused || world.revision !== item.worldRevision) return 'dropped:paused';
    if (now >= item.expiresAt) return 'dropped:expired';
    // Only a proactive request ever waits here; a completion is created handed out, under its own rule below.
    if (item.kind !== 'proactive') return 'dropped:target';
    // A proactive request goes to the owner only, in the private conversation the owner last spoke in.
    const target = this.#recentStream(OWNER);
    if (item.personId !== OWNER || !target || target.capabilityId !== item.capabilityId || target.streamId !== item.streamId || target.entityId !== item.entityId) return 'dropped:target';
    if (this.streamEpoch(this.entity(item.entityId), item.capabilityId, item.streamId) !== item.memoryEpoch) return 'dropped:epoch';
    if (quietHours(now, quiet)) return 'dropped:quiet_hours';
    // The person has spoken since: their message gets an ordinary reply instead.
    if (this.store.db.prepare("SELECT 1 FROM observations WHERE capability_id=? AND stream_id=? AND rowid>? AND json_extract(body,'$.role')='user' LIMIT 1").get(item.capabilityId, item.streamId, item.afterRow)) return 'dropped:person_spoke';
    return null;
  }
  /** Why a finished job can never be told (`dropped:<reason>`), or null. The target is the conversation the job was
   * registered in, held against Authority's own bindings now: still bound on `capabilityId`, still private, still the
   * same person and entity, an account of that person still bound on that channel, the same memory epoch, and the
   * message that asked for the job (when one did) not forgotten. */
  #jobRefusal(job, capabilityId) {
    const { scope, source } = job;
    if (typeof scope.streamId !== 'string' || typeof scope.personId !== 'string' || typeof scope.entityId !== 'string' || scope.audience !== 'private') return 'dropped:target';
    const stream = this.store.db.prepare('SELECT person_id AS personId,audience,entity_id AS entityId FROM streams WHERE capability_id=? AND stream_id=?').get(capabilityId, scope.streamId);
    if (!stream || stream.personId !== scope.personId || stream.audience !== 'private' || stream.entityId !== scope.entityId) return 'dropped:target';
    if (!this.store.db.prepare('SELECT 1 FROM actors WHERE capability_id=? AND person_id=? LIMIT 1').get(capabilityId, scope.personId)) return 'dropped:target';
    if (this.streamEpoch(this.entity(scope.entityId), capabilityId, scope.streamId) !== scope.memoryEpoch) return 'dropped:epoch';
    if (source?.sourceEventId != null) {
      const asked = typeof source.sourceEventId === 'string' ? this.store.db.prepare('SELECT forgotten FROM observations WHERE capability_id=? AND stream_id=? AND event_id=?').get(capabilityId, scope.streamId, source.sourceEventId) : null;
      if (!asked || asked.forgotten) return 'dropped:forgotten';
    }
    return null;
  }
  /** Why she may not start a turn about a finished job now, or null. Held back, the result is not lost: it rides on
   * the person's next message and on nothing else (nothing is made up for after a pause or in the quiet hours). */
  #jobHold(job, capabilityId, world, now, quiet) {
    if (world.paused || world.revision !== job.worldRevision) return 'dropped:paused';
    if (now - job.endedAt >= INITIATION.completionMs) return 'dropped:expired';
    if (quietHours(now, quiet) && !this.store.db.prepare("SELECT 1 FROM observations WHERE capability_id=? AND stream_id=? AND forgotten=0 AND json_extract(body,'$.role')='user' AND json_extract(body,'$.at')>=? LIMIT 1").get(capabilityId, job.scope.streamId, now - INITIATION.recentMs)) return 'dropped:quiet_hours';
    return null;
  }
  /** The finished jobs of one channel that may still be told, out of what the content service listed as untold. A
   * job is its conversation's, and a conversation is on one channel: a job of another channel is left to that
   * channel's bridge, and one whose conversation is bound nowhere is closed by whoever asks. One that was already
   * handed out or settled here is not among them, whatever the content service believes: it is told again how it
   * stands instead. One that can never be told is closed there (and its result deleted). */
  #untold(state, jobs, capabilityId) {
    const untold = [], channels = this.store.db.prepare("SELECT s.capability_id AS id FROM streams s JOIN capabilities c ON c.id=s.capability_id AND c.policy='conversation.v1' WHERE s.stream_id=?");
    for (const job of Array.isArray(jobs) ? jobs.filter(validJob) : []) {
      const bound = typeof job.scope.streamId === 'string' ? channels.all(job.scope.streamId).map(row => row.id) : [];
      if (bound.length === 1 && bound[0] !== capabilityId) continue;
      const items = state.items.filter(item => item.jobRef === job.id), settled = items.find(item => item.status === 'closed' && SETTLED.includes(item.outcome));
      if (items.some(item => item.status !== 'closed')) { this.#notices.push({ id: job.id, state: 'issued' }); continue; }
      if (settled) { this.#notices.push({ id: job.id, state: 'closed', outcome: settled.outcome }); continue; }
      const refusal = bound.length === 1 ? this.#jobRefusal(job, capabilityId) : 'dropped:target';
      if (refusal) { this.#notices.push({ id: job.id, state: 'closed', outcome: refusal }); continue; }
      untold.push(job);
    }
    return untold;
  }
  /** A finished job is handed out: from here on it is never offered again. */
  #issue(state, job, capabilityId, now, carried) {
    const item = {
      id: randomUUID(), kind: 'completion', source: 'job', capabilityId, streamId: job.scope.streamId, personId: job.scope.personId, entityId: job.scope.entityId,
      memoryEpoch: job.scope.memoryEpoch, jobRef: job.id, keepUntil: job.expiresAt, ...(carried ? { carried: true } : {}), createdAt: now, issuedAt: now, expiresAt: now + INITIATION.ttlMs, status: 'issued',
    };
    state.items.push(item); this.#notices.push({ id: job.id, state: 'issued' });
    return { id: item.id, kind: item.kind, streamId: item.streamId, memoryEpoch: item.memoryEpoch, expiresAt: item.expiresAt, jobRef: item.jobRef, ...(carried ? { carried: true } : {}) };
  }
  #view(item) {
    return { id: item.id, kind: item.kind, source: item.source, person: opaquePerson(item.personId), owner: item.personId === OWNER, status: item.status, outcome: item.outcome ?? null, createdAt: item.createdAt, issuedAt: item.issuedAt ?? null, endedAt: item.endedAt ?? null };
  }
  /** Operator only: one initiated run towards the owner's own private conversation, on the channel where the owner
   * last spoke. The request takes no
   * argument, so it can name nobody else. One request is open at a time; a request that may not go out now is
   * recorded closed with the reason. */
  initiationPoke(input = {}) {
    closed(input, [], []);
    return this.store.transaction(() => {
      const state = this.#state(), world = this.worldStatus(), now = this.now();
      this.#settle(state, world, now);
      const target = this.#recentStream(OWNER);
      if (!target) fail('CONFLICT', 'Bind the owner before initiating', 409);
      const open = state.items.find(item => item.status !== 'closed');
      if (open) { this.#save(state); return { ...this.#view(open), already: true }; }
      const item = {
        id: randomUUID(), kind: 'proactive', source: 'poke', capabilityId: target.capabilityId, streamId: target.streamId, personId: OWNER, entityId: target.entityId,
        memoryEpoch: this.streamEpoch(this.entity(target.entityId), target.capabilityId, target.streamId), worldRevision: world.revision,
        afterRow: this.store.db.prepare('SELECT MAX(rowid) AS n FROM observations').get().n ?? 0, createdAt: now, expiresAt: now + INITIATION.ttlMs, status: 'waiting',
      };
      const refusal = this.#refusal(item, world, now, this.#quiet(state));
      if (refusal) this.#close(item, refusal, now);
      state.items.push(item);
      this.#save(state);
      return this.#view(item);
    });
  }
  /** A conversation channel's credential only. Authority picks: the caller can name no conversation, person or
   * request, and is only handed requests of its own channel. At most one request is out per channel. `jobs` is what the content service lists as finished and untold (the
   * transport asks it with Authority's own control credential; the caller of this route supplies nothing). */
  initiationNext(capabilityId, input = {}, jobs = []) {
    // `busy`: the caller has turns queued or running. It only ever holds back her own wake-up.
    closed(input, ['busy'], []);
    if (input.busy !== undefined && typeof input.busy !== 'boolean') fail('VALIDATION_ERROR', 'busy must be boolean');
    if (capability(this.store, capabilityId).policy !== 'conversation.v1') fail('FORBIDDEN', 'Initiations are for conversation channels', 403);
    return this.store.transaction(() => {
      const state = this.#state(), stored = JSON.stringify(state), world = this.worldStatus(), now = this.now();
      this.#settle(state, world, now);
      let initiation = null, reason = world.paused ? 'paused' : 'idle';
      // A finished job she may not start a turn about now becomes carry-only, whether or not anything is handed out.
      const quiet = this.#quiet(state), ready = this.#untold(state, jobs, capabilityId).filter(job => job.notice !== 'carry').filter(job => {
        const hold = this.#jobHold(job, capabilityId, world, now, quiet);
        if (hold) this.#notices.push({ id: job.id, state: 'carry', outcome: hold });
        return !hold;
      });
      if (state.items.some(item => item.status === 'issued' && item.capabilityId === capabilityId)) reason = 'busy';
      else {
        const item = state.items.find(entry => entry.status === 'waiting' && entry.capabilityId === capabilityId);
        if (item) {
          item.status = 'issued'; item.issuedAt = now;
          initiation = { id: item.id, kind: item.kind, streamId: item.streamId, memoryEpoch: item.memoryEpoch, expiresAt: item.expiresAt };
        } else if (ready.length) initiation = this.#issue(state, ready[0], capabilityId, now, false);
        // Nothing for anybody: her own wake-up may be due (a request to a person always goes first).
        else {
          const wake = this.#wakeNext(capabilityId, { busy: input.busy === true, quiet, world, now, items: state.items });
          if (wake === 'out') reason = 'busy'; else if (wake) initiation = wake;
        }
      }
      // An idle poll writes nothing.
      if (JSON.stringify(state) !== stored) this.#save(state);
      return initiation ? { initiation } : { initiation: null, reason };
    });
  }
  /** A conversation channel's credential only, asked as an ordinary turn of `streamId` begins: is there a finished job of this
   * very conversation that the person was not told about yet? If so it is handed out to ride on this turn (report
   * `carried` once the model has it), and she does not start a turn about it. The conversation the caller names
   * only selects among jobs registered in it; every check of a completion applies. */
  initiationCarry(capabilityId, input, jobs = []) {
    closed(input, ['streamId']); identifier(input.streamId);
    if (capability(this.store, capabilityId).policy !== 'conversation.v1') fail('FORBIDDEN', 'Initiations are for conversation channels', 403);
    return this.store.transaction(() => {
      const state = this.#state(), stored = JSON.stringify(state), world = this.worldStatus(), now = this.now();
      const job = this.#untold(state, jobs, capabilityId).find(entry => entry.scope.streamId === input.streamId);
      const initiation = job && !world.paused ? this.#issue(state, job, capabilityId, now, true) : null;
      if (JSON.stringify(state) !== stored) this.#save(state);
      return { initiation };
    });
  }
  /** A conversation channel's credential only, about a request of that channel: how a fetched request ended. Reported once; the same report again changes
   * nothing, a different one is refused (except over a request closed for want of any report). */
  initiationAck(capabilityId, input) {
    closed(input, ['id', 'outcome']);
    identifier(input.id);
    if (typeof input.outcome !== 'string' || !(INITIATION_OUTCOMES.includes(input.outcome) || WAKE_OUTCOMES.includes(input.outcome) || DROPPED.test(input.outcome))) fail('VALIDATION_ERROR', 'Unsupported initiation outcome');
    if (capability(this.store, capabilityId).policy !== 'conversation.v1') fail('FORBIDDEN', 'Initiations are for conversation channels', 403);
    return this.store.transaction(() => {
      const state = this.#state(), now = this.now(), item = state.items.find(entry => entry.id === input.id);
      const wake = item ? null : this.#wakeAck(capabilityId, input, now, state);
      if (wake) return wake;
      // `done` is how a wake-up ends, and nothing else ends that way.
      if (input.outcome === 'done') fail('CONFLICT', 'Initiation is not a wake-up', 409);
      if (!item || item.capabilityId !== capabilityId || item.status === 'waiting') fail('CONFLICT', 'Initiation is not out', 409);
      // `carried` is how a result that rode on the person's message ends, and nothing else ends that way.
      if (input.outcome === 'carried' && !item.carried) fail('CONFLICT', 'Initiation was not carried', 409);
      if (item.status === 'closed') {
        if (item.outcome === input.outcome) return { status: 'recorded', replayed: true };
        if (!item.unreported) fail('CONFLICT', 'Initiation was already reported', 409);
      }
      this.#close(item, input.outcome, now); delete item.unreported;
      if (item.jobRef) this.#notices.push({ id: item.jobRef, state: SETTLED.includes(input.outcome) ? 'closed' : 'carry', outcome: input.outcome });
      // The gateway's spend tier refused the run (it stops this kind of work first): recorded, nothing is retried.
      if (input.outcome === 'deferred:budget') state.deferredAt = now;
      this.#save(state);
      return { status: 'recorded' };
    });
  }
  /** Operator only: the scope of the owner's own private conversation (where the owner last spoke), for a job the operator registers there
   * (the demonstration job). It takes no argument, so such a job can only ever belong to the owner. */
  ownerContentScope() {
    const target = this.#recentStream(OWNER);
    if (!target) fail('CONFLICT', 'Bind the owner before registering a job', 409);
    return this.contentScope(target.capabilityId, { streamId: target.streamId, memoryEpoch: this.streamEpoch(this.entity(target.entityId), target.capabilityId, target.streamId) });
  }
  /** Operator only: the content service's job list with each conversation replaced by an opaque person label. */
  jobList(listing) {
    const jobs = Array.isArray(listing?.jobs) ? listing.jobs : [];
    return { limits: listing?.limits ?? null, jobs: jobs.map(({ scope, ...job }) => ({ ...job, person: typeof scope?.personId === 'string' ? opaquePerson(scope.personId) : null, owner: scope?.personId === OWNER })) };
  }
  /** The room's read-only projection (room.js): a category of activity and its times, nothing of anyone. Unlike
   * `initiationLog()` it settles and saves nothing, so it may be polled. The newest message time is taken from the
   * last 64 observations to arrive, which bounds the read whatever the history's size. */
  roomState(listing) {
    this.store.check();
    const now = this.now(), quiet = this.#quiet(this.#state());
    const lastAts = this.store.db.prepare("SELECT json_extract(body,'$.at') AS at FROM observations ORDER BY rowid DESC LIMIT 64").all().map(row => row.at);
    return roomProjection({ now, paused: this.worldStatus().paused, quiet: { now: quietHours(now, quiet), fromMinute: quiet.fromMinute }, jobs: listing?.jobs, lastAts });
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
  /** Operator only: the quiet hours as Beijing wall-clock times `{quietHours:{from:'HH:MM',to:'HH:MM'}}` (equal
   * ends mean no quiet hours; no console form uses it yet: scenario replay does, to run at any hour), and her private
   * wake-up `{wake:{enabled?,perDay?}}` (off until the operator turns it on; `perDay` 1..WAKE.perDayMax). Either
   * or both. */
  initiationSettings(input) {
    closed(input, ['quietHours', 'wake'], []);
    if (input.quietHours === undefined && input.wake === undefined) fail('VALIDATION_ERROR', 'Nothing to change');
    let minutes = null;
    if (input.quietHours !== undefined) {
      closed(input.quietHours, ['from', 'to']);
      minutes = ['from', 'to'].map(key => { const match = typeof input.quietHours[key] === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.quietHours[key]) : null; if (!match) fail('VALIDATION_ERROR', 'Quiet hours are HH:MM'); return Number(match[1]) * 60 + Number(match[2]); });
    }
    if (input.wake !== undefined) {
      closed(input.wake, ['enabled', 'perDay'], []);
      if (input.wake.enabled !== undefined && typeof input.wake.enabled !== 'boolean') fail('VALIDATION_ERROR', 'enabled must be boolean');
      if (input.wake.perDay !== undefined && !(Number.isInteger(input.wake.perDay) && input.wake.perDay >= 1 && input.wake.perDay <= WAKE.perDayMax)) fail('VALIDATION_ERROR', 'perDay is out of range');
    }
    return this.store.transaction(() => {
      const state = this.#state();
      if (minutes) { state.quiet = { fromMinute: minutes[0], toMinute: minutes[1] }; this.#save(state); }
      const own = this.#initiative();
      if (input.wake) { own.wake = { ...this.#wakeSettings(own), ...input.wake }; this.#saveInitiative(own); }
      const quiet = this.#quiet(state);
      return { quietHours: { from: clock(quiet.fromMinute), to: clock(quiet.toMinute), timezone: 'Asia/Shanghai', now: quietHours(this.now(), quiet) }, ...(input.wake ? { wake: this.#wakeSettings(own) } : {}) };
    });
  }

  // ---- Her private wake-up (wake.js). Everything below reaches nobody: no request to any person is made from it. ----
  #initiative() {
    const row = this.store.db.prepare("SELECT value FROM metadata WHERE key='initiative'").get();
    return row ? JSON.parse(row.value) : {};
  }
  #saveInitiative(own) { this.store.db.prepare("INSERT INTO metadata(key,value) VALUES('initiative',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(own)); }
  #wakeLog() {
    const row = this.store.db.prepare("SELECT value FROM metadata WHERE key='initiative.log'").get();
    return row ? JSON.parse(row.value) : [];
  }
  #saveWakeLog(log) { this.store.db.prepare("INSERT INTO metadata(key,value) VALUES('initiative.log',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(log.slice(-WAKE.log))); }
  #wakeSettings(own) {
    const perDay = own.wake?.perDay;
    return { enabled: own.wake?.enabled === true, perDay: Number.isInteger(perDay) && perDay >= 1 && perDay <= WAKE.perDayMax ? perDay : WAKE.perDay };
  }
  /** Wake-ups that ran (or may have) on the Beijing day of `now`: one the spend tier refused or the bridge never started does not count. */
  #wokeToday(log, now) {
    const day = beijingDay(now);
    return log.filter(entry => entry.type === 'wake' && beijingDay(entry.at) === day && entry.outcome !== 'deferred:budget' && !entry.outcome.startsWith('dropped:')).length;
  }
  /** A wake-up that was due and did not happen: counted by reason, merged into one entry a Beijing day. */
  #skip(log, reason, now) {
    const day = beijingDay(now);
    let entry = log.findLast(item => item.type === 'skip' && item.day === day);
    if (!entry) { entry = { type: 'skip', day, at: now, counts: {} }; log.push(entry); }
    entry.counts[reason] = (entry.counts[reason] ?? 0) + 1; entry.at = now;
  }
  /** The next wake-up is brought forward to now, but never closer than WAKE.minGapMs to the one before it. */
  #bringForward(own, now, reason) {
    const at = Math.max(now, (own.lastWakeAt ?? -Infinity) + WAKE.minGapMs);
    if (!(own.nextAt <= at)) own.nextAt = at;
    own.nextReason = reason;
  }
  /** Her tier as it stands: what she last chose under the persona card now current, else 'none'. */
  #tier(own, cardId) { return OUTREACH_TIERS.includes(own.outreach?.tier) && (own.outreach.cardId ?? DEFAULT_CARD_ID) === cardId ? own.outreach.tier : 'none'; }
  /** The turns she started that went out since `since`, from the kept requests (the newest 50 closed ones). */
  #reached(items, since) { return items.filter(item => item.kind === 'proactive' && ['sent', 'partial'].includes(item.outcome) && item.endedAt >= since); }
  /** Is her wake-up due on this channel, and may it happen now? Returns the request to hand out, 'out' while one is
   * out, or null. Only the channel the owner last spoke on carries wake-ups (so one bridge runs them). Decided here
   * and nowhere else: the caller only says whether it has turns queued. A wake-up that is due and may not happen is
   * counted with its reason and not made up for. */
  #wakeNext(capabilityId, { busy, quiet, world, now, items }) {
    const target = this.#recentStream(OWNER);
    if (!target || target.capabilityId !== capabilityId) return null;
    const own = this.#initiative(), stored = JSON.stringify(own), log = this.#wakeLog(), logged = JSON.stringify(log), random = this.random ?? Math.random;
    const done = value => { if (JSON.stringify(own) !== stored) this.#saveInitiative(own); if (JSON.stringify(log) !== logged) this.#saveWakeLog(log); return value; };
    if (own.out) {
      if (now - own.out.issuedAt < INITIATION.reportMs) return done('out');
      // Fetched and never reported: what became of it is unknown. The bridge's own report may still replace that.
      this.#wakeEnd(own, log, 'unknown', now, items, { unreported: true });
    }
    const today = beijingDay(now), settings = this.#wakeSettings(own);
    // An intent that came due brings the next wake-up forward. Only the number of people is read, nothing of any intent.
    const intentPeople = Object.keys(this.openIntentCounts({ entityId: target.entityId, dueBy: today })).length;
    if (own.due?.day !== today) own.due = { day: today, people: 0 };
    if (intentPeople > own.due.people) this.#bringForward(own, now, 'intent_due');
    own.due.people = intentPeople;
    if (!settings.enabled) {
      // Off: nothing is scheduled; only something that asked for a wake-up (the operator, an intent) is counted.
      if (own.nextReason) this.#skip(log, 'off', now);
      delete own.nextAt; delete own.nextReason;
      return done(null);
    }
    if (!Number.isSafeInteger(own.nextAt)) own.nextAt = regularNext(now, random);
    if (now < own.nextAt) return done(null);
    const woke = this.#wokeToday(log, now), streamId = selfStream(capabilityId);
    const bound = this.store.db.prepare('SELECT person_id AS personId,audience,entity_id AS entityId FROM streams WHERE capability_id=? AND stream_id=?').get(capabilityId, streamId);
    const blocked = world.paused ? 'paused' : quietHours(now, quiet) ? 'quiet_hours' : own.deferredDay === today ? 'budget' : busy ? 'busy'
      : woke >= WAKE.fuseWakesPerDay ? 'fuse:wakes_per_day' : woke >= settings.perDay ? 'daily_limit' : bound && (bound.personId !== SELF_PERSON || bound.audience !== 'private') ? 'target' : null;
    if (blocked) {
      this.#skip(log, blocked, now);
      // Quiet hours and a busy bridge only move it (the reason it was due stays); anything else is not made up for.
      if (blocked === 'quiet_hours') own.nextAt = afterQuiet(now, quiet, random);
      else if (blocked === 'busy') own.nextAt = now + WAKE.busyRetryMs;
      else { own.nextAt = ['paused', 'target'].includes(blocked) ? regularNext(now, random) : nextDay(now, random); delete own.nextReason; }
      return done(null);
    }
    // Her own conversation on this channel: bound to the reserved person, who is nobody.
    const entityId = bound?.entityId ?? target.entityId;
    if (!bound) {
      this.store.db.prepare('INSERT INTO streams(capability_id,stream_id,person_id,audience,entity_id) VALUES(?,?,?,?,?)').run(capabilityId, streamId, SELF_PERSON, 'private', entityId);
      this.adminAudit('stream.bind', { capabilityId, streamId, personId: SELF_PERSON, audience: 'private', entityId });
    }
    const entity = this.entity(entityId), cardId = this.currentCardId(entityId), midnight = beijingMidnight(now);
    // Counts about herself. How many people, never who.
    const counts = {
      wokeToday: woke, sinceLastMs: Number.isSafeInteger(own.lastWakeAt) ? now - own.lastWakeAt : null,
      reachedToday: new Set(this.#reached(items, midnight).map(item => item.personId)).size, intentPeople,
      chattedPeople: this.store.db.prepare(`SELECT COUNT(DISTINCT s.person_id) AS n FROM observations o JOIN streams s ON s.capability_id=o.capability_id AND s.stream_id=o.stream_id
        JOIN capabilities c ON c.id=s.capability_id AND c.policy='conversation.v1' WHERE s.audience='private' AND s.entity_id=? AND s.person_id<>? AND o.forgotten=0 AND json_extract(o.body,'$.role')='user' AND json_extract(o.body,'$.at')>=?`).get(entityId, SELF_PERSON, midnight).n,
    };
    // Her mood is subjective memory: only one written under the persona card now current is read back.
    const mood = (own.moods ?? []).findLast(item => (item.cardId ?? DEFAULT_CARD_ID) === cardId) ?? null, reason = own.nextReason ?? 'schedule';
    own.out = { id: randomUUID(), capabilityId, streamId, entityId, memoryEpoch: this.streamEpoch(entity, capabilityId, streamId), issuedAt: now, reason, counts, did: {} };
    own.lastWakeAt = now; own.nextAt = regularNext(now, random); delete own.nextReason;
    return done({ id: own.out.id, kind: 'wake', streamId, memoryEpoch: own.out.memoryEpoch, expiresAt: now + INITIATION.ttlMs, briefing: renderBriefing({ now, reason, counts, mood: mood && { text: mood.text, at: mood.at }, tier: this.#tier(own, cardId) }) });
  }
  /** A wake-up ends: one log entry. After one that ran, the pick of a person is worked through for her tier and
   * recorded; it is not acted on (step 6b). */
  #wakeEnd(own, log, outcome, now, items, { unreported = false } = {}) {
    const out = own.out; delete own.out;
    const entry = { id: out.id, type: 'wake', at: out.issuedAt, endedAt: now, reason: out.reason, outcome, counts: out.counts, did: { ...out.did, rested: outcome === 'done' && !Object.keys(out.did).length }, tier: null, selection: null, second: null, fuses: [], ...(unreported ? { unreported: true } : {}) };
    if (outcome === 'done') {
      entry.tier = this.#tier(own, this.currentCardId(out.entityId));
      if (entry.tier !== 'none') { const { fuses, ...selection } = this.#selection(out.entityId, entry.tier, now, items); entry.selection = selection; entry.fuses = fuses; }
    }
    // The gateway's spend tier refused the run: no wake-up for the rest of that Beijing day.
    if (outcome === 'deferred:budget') own.deferredDay = beijingDay(now);
    log.push(entry);
  }
  /** Who would be picked (design §3.4), worked through from Authority's own tables: everyone with an account and a
   * private conversation on a conversation channel, minus those a forced rule keeps out, each with the product of
   * their weights, and "nobody this time". People appear as opaque labels. This step has no per-person switch yet, so
   * nobody is kept out for one. */
  #selection(entityId, tier, now, items) {
    const db = this.store.db, open = this.openIntentCounts({ entityId }), due = this.openIntentCounts({ entityId, dueBy: beijingDay(now) });
    const people = db.prepare(`SELECT DISTINCT s.person_id AS personId FROM streams s JOIN capabilities c ON c.id=s.capability_id AND c.policy='conversation.v1'
      WHERE s.audience='private' AND s.entity_id=? AND s.person_id<>? AND EXISTS (SELECT 1 FROM actors a WHERE a.capability_id=s.capability_id AND a.person_id=s.person_id) ORDER BY s.person_id`).all(entityId, SELF_PERSON);
    const lines = db.prepare(`SELECT MIN(json_extract(o.body,'$.at')) AS firstAt,MAX(json_extract(o.body,'$.at')) AS lastAt,
      MAX(CASE WHEN json_extract(o.body,'$.role')='user' THEN json_extract(o.body,'$.at') END) AS lastUserAt,
      COALESCE(SUM(json_extract(o.body,'$.role')='user'),0) AS lines,COALESCE(SUM(json_extract(o.body,'$.role')='user' AND json_extract(o.body,'$.at')>=?),0) AS lines14
      FROM observations o JOIN streams s ON s.capability_id=o.capability_id AND s.stream_id=o.stream_id WHERE s.person_id=? AND s.audience='private' AND s.entity_id=? AND o.forgotten=0`);
    const boundary = db.prepare("SELECT 1 FROM memory_items WHERE entity_id=? AND person_id=? AND collection='appraisals' AND kind='boundary' AND status='active' AND json_extract(body,'$.evidence.at')>=? LIMIT 1");
    const sent = this.#reached(items, 0), candidates = [], excluded = [], reachedBy = new Map();
    for (const { personId } of people) {
      const person = opaquePerson(personId), row = lines.get(now - SELECTION.chatterMs, personId, entityId), mine = sent.filter(item => item.personId === personId);
      const owner = personId === OWNER ? { owner: true } : {};
      if (boundary.get(entityId, personId, now - SELECTION.boundaryMs)) { excluded.push({ person, ...owner, reason: 'boundary' }); continue; }
      if (row.lastAt !== null && now - row.lastAt < SELECTION.recentMs) { excluded.push({ person, ...owner, reason: 'recent' }); continue; }
      const stats = {
        intent: due[personId] ? 'due' : open[personId] ? 'open' : 'none', lines14: row.lines14, lastAt: row.lastUserAt, firstAt: row.firstAt, lines: row.lines,
        reached7: mine.filter(item => item.endedAt >= now - SELECTION.reachedMs).length, unanswered: mine.filter(item => item.endedAt > (row.lastUserAt ?? 0)).length,
      };
      candidates.push({ person, ...owner, ...candidateWeights(stats, now) });
      reachedBy.set(person, mine);
    }
    const selection = pick({ tier, candidates, excluded, random: this.random ?? Math.random }), fuses = [];
    // The high fuses, as they would stand for the person picked. Nothing is sent in this step, so they only show here.
    if (selection.result !== 'none') {
      const mine = reachedBy.get(selection.result), day = beijingMidnight(now), limits = SELECTION.fuses;
      if (sent.filter(item => item.endedAt >= day).length >= limits.per_day) fuses.push('fuse:per_day');
      if (mine.filter(item => item.endedAt >= day).length >= limits.per_person_day) fuses.push('fuse:per_person_day');
      if (mine.filter(item => item.endedAt >= now - SELECTION.reachedMs).length >= limits.per_person_week) fuses.push('fuse:per_person_week');
      if (sent.filter(item => item.endedAt >= now - 60 * MINUTE).length >= limits.per_hour) fuses.push('fuse:per_hour');
    }
    return { ...selection, fuses };
  }
  /** The bridge's report about a wake-up, or null when `input.id` is not one. Reported once, like any request. */
  #wakeAck(capabilityId, input, now, state) {
    const own = this.#initiative(), log = this.#wakeLog(), wakeOutcome = WAKE_OUTCOMES.includes(input.outcome) || DROPPED.test(input.outcome);
    if (own.out?.id === input.id) {
      if (own.out.capabilityId !== capabilityId) fail('CONFLICT', 'Initiation is not out', 409);
      if (!wakeOutcome) fail('VALIDATION_ERROR', 'Unsupported wake outcome');
      this.#wakeEnd(own, log, input.outcome, now, state.items);
      this.#saveInitiative(own); this.#saveWakeLog(log);
      return { status: 'recorded' };
    }
    const entry = log.find(item => item.type === 'wake' && item.id === input.id);
    if (!entry) return null;
    if (entry.outcome === input.outcome) return { status: 'recorded', replayed: true };
    if (!entry.unreported || !wakeOutcome) fail('CONFLICT', 'Initiation was already reported', 409);
    // Closed for want of a report, and the report came after all (what she did in it is already in the entry).
    entry.outcome = input.outcome; entry.endedAt = now; delete entry.unreported;
    if (input.outcome === 'deferred:budget') { own.deferredDay = beijingDay(now); this.#saveInitiative(own); }
    this.#saveWakeLog(log);
    return { status: 'recorded' };
  }
  /** A conversation channel's credential, from inside the wake-up that is out on that channel (the model tool
   * `companion_self`): what she writes down for herself. `{streamId,mood?,note?,outreach?}`; the conversation must be
   * the one the wake-up was handed out for. A mood (<=120 characters) and a note (<=400) pass the checks of a machine
   * digest or are refused with the reason; the caller is told which. Stored with the wake-up and the persona card they
   * were written under. They are read in two places only: the operator's page and her next briefing (the mood).
   * Nothing here is read by any conversation with a person. */
  selfRecord(capabilityId, input) {
    closed(input, ['streamId', 'mood', 'note', 'outreach'], ['streamId']); identifier(input.streamId);
    for (const key of ['mood', 'note']) if (input[key] !== undefined && typeof input[key] !== 'string') fail('VALIDATION_ERROR', `${key} must be a string`);
    if (input.outreach !== undefined && !OUTREACH_TIERS.includes(input.outreach)) fail('VALIDATION_ERROR', 'Unsupported outreach tier');
    if (capability(this.store, capabilityId).policy !== 'conversation.v1') fail('FORBIDDEN', 'Not a conversation channel', 403);
    return this.store.transaction(() => {
      const own = this.#initiative(), out = own.out, now = this.now();
      if (!out || out.capabilityId !== capabilityId || out.streamId !== input.streamId) fail('CONFLICT', 'No wake-up is out for this conversation', 409);
      if (this.worldStatus().paused) fail('CONFLICT', 'World is paused', 409);
      const cardId = this.currentCardId(out.entityId), result = {};
      for (const [key, list, max, kept] of [['mood', 'moods', WAKE.moodChars, WAKE.moods], ['note', 'notes', WAKE.noteChars, WAKE.notes]]) {
        if (input[key] === undefined) continue;
        const refused = refusedText(input[key], max);
        result[key] = out.did[key] = refused ? `rejected:${refused}` : 'accepted';
        if (!refused) own[list] = [...(own[list] ?? []), { text: input[key].trim(), at: now, wakeId: out.id, cardId }].slice(-kept);
      }
      if (input.outreach !== undefined) { own.outreach = { tier: input.outreach, cardId, at: now }; result.outreach = out.did.outreach = input.outreach; }
      this.#saveInitiative(own);
      return result;
    });
  }
  /** Operator only: bring the next wake-up forward to now. Every rule still applies when the bridge next asks (the
   * switch, a pause, the quiet hours, the spend tier, a busy bridge, the day's count, 45 minutes since the last one);
   * `blocked` is what would stop it as things stand. The request names nothing and nobody. */
  initiativeWake(input = {}) {
    closed(input, [], []);
    return this.store.transaction(() => {
      const own = this.#initiative(), now = this.now(), settings = this.#wakeSettings(own);
      this.#bringForward(own, now, 'manual');
      this.#saveInitiative(own);
      const blocked = !settings.enabled ? 'off' : this.worldStatus().paused ? 'paused' : quietHours(now, this.#quiet(this.#state())) ? 'quiet_hours' : own.deferredDay === beijingDay(now) ? 'budget' : this.#wokeToday(this.#wakeLog(), now) >= settings.perDay ? 'daily_limit' : null;
      return { scheduledAt: own.nextAt, blocked };
    });
  }
  /** Operator only, read-only: her wake-up settings and schedule, her moods and notes (her own words, newest first),
   * and the wake log, newest first: when and why she woke, the counts she was told, what she did, and the pick of a
   * person worked through (opaque labels and weights). No message text, no intent text, no account. */
  initiativeView() {
    this.store.check();
    const own = this.#initiative(), log = this.#wakeLog(), now = this.now(), settings = this.#wakeSettings(own);
    const newest = list => [...(list ?? [])].reverse().map(({ text, at, wakeId, cardId }) => ({ text, at, wakeId, cardId: cardId ?? DEFAULT_CARD_ID }));
    return {
      wake: { ...settings, perDayMax: WAKE.perDayMax, intervalMinutes: WAKE.intervalMs / MINUTE, minGapMinutes: WAKE.minGapMs / MINUTE },
      nextAt: settings.enabled && Number.isSafeInteger(own.nextAt) ? own.nextAt : null, lastWakeAt: own.lastWakeAt ?? null, out: own.out ? { id: own.out.id, issuedAt: own.out.issuedAt } : null,
      wokeToday: this.#wokeToday(log, now), outreach: this.#tier(own, this.currentCardId()), moods: newest(own.moods), notes: newest(own.notes),
      log: [...log].sort((a, b) => b.at - a.at),
    };
  }
}
