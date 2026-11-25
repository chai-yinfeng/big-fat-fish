// Initiated runs: a turn she starts in one person's private conversation when that person has sent nothing.
// A request is registered here, fetched by the bridge of the channel it is for (which can name no conversation
// or person: Authority picks, as with consolidation), run in that conversation's own queue and reported back once.
// Which channel: the private conversation in which that person last spoke. A bridge is only ever handed requests
// of its own channel (the capability of the credential it calls with) and can only report on those.
// A request that cannot go out is closed with the reason, never kept for later: nothing is sent after a
// pause, in the quiet hours or once the person has spoken, and a request that went out is never handed out
// again, whatever became of it.
// Two kinds, each with its own rule for whom it may reach:
// - `proactive`: she decides to speak. Two sources. The operator's "try it on me" (`source: 'poke'`) may only name the
//   owner's own private conversation (the one they last spoke in). A wake-up in which she named a person and Authority
//   accepted it (`source: 'reach'`, wake.js) names the private conversation that person last spoke in: the owner or
//   an admitted person whose switch the operator turned on, never a group. Authority builds its event block (her
//   reason, that person's intents and soft facts, nothing of anyone else) and hands it out with the request.
// - `notice`: a fixed line to the owner that a high fuse was hit. No model is asked; the bridge holds the text.
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
import { SENSITIVE } from './policies.js';
import { REACH, SELF_PERSON, WAKE, WAKE_OUTCOMES, beijingDay, beijingMidnight, clip, nextWake, refusedReason, refusedText, renderBriefing, renderCard, renderReachEvent, repeatsWords, selfStream, withoutLabels } from './wake.js';

const MINUTE = 60000, BEIJING = 8 * 3600000;
/** The most the operator may set a high fuse to. */
const FUSE_MAX = 1000;
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
      else continue;
      if (item.status === 'closed' && item.source === 'reach') this.#reachEnded(state, item, now, world);
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
    // Only a proactive request or a notice ever waits here; a completion is created handed out, under its own rule below.
    const reach = item.kind === 'proactive' && item.source === 'reach';
    if (item.kind !== 'proactive' && item.kind !== 'notice') return 'dropped:target';
    // The operator's poke and a notice go to the owner only; a request from a wake-up goes to the person she named.
    // Either way: the private conversation that person last spoke in, as Authority's own bindings stand now.
    if (!reach && item.personId !== OWNER) return 'dropped:target';
    const target = this.#recentStream(item.personId);
    if (!target || target.capabilityId !== item.capabilityId || target.streamId !== item.streamId || target.entityId !== item.entityId) return 'dropped:target';
    if (this.streamEpoch(this.entity(item.entityId), item.capabilityId, item.streamId) !== item.memoryEpoch) return 'dropped:epoch';
    if (quietHours(now, quiet)) return 'dropped:quiet_hours';
    if (item.kind === 'notice') return null;
    // The forced rules of reaching out, as they stand now (a switch turned off meanwhile, a fuse hit, the spend tier).
    if (reach) { const refused = this.#reachRefusal(this.#initiative(), item.entityId, item.personId, now); if (refused) return `dropped:${refused}`; }
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
      const open = state.items.find(item => item.status !== 'closed' && item.source === 'poke');
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
          if (item.kind === 'notice') initiation.notice = item.notice;
          // A request from a wake-up carries its event block, built now from this one person's material: her reason
          // as it was kept, her unsettled intents about them, the soft facts about them. Those of the intents whose
          // day has come (or that have none) are remembered: they are settled once the turn is delivered. `light`:
          // the turn does not think on its own account (it follows the switch of everyday chat).
          if (item.source === 'reach') {
            const intents = this.openIntents(item.entityId, item.personId), today = beijingDay(now);
            item.intentIds = intents.filter(intent => intent.dueDate === null || intent.dueDate <= today).map(intent => intent.id);
            initiation.event = renderReachEvent({ reason: item.reason, intents, stats: this.#personStats(this.#initiative(), item.entityId, item.personId, now), now });
            initiation.light = true;
          }
        } else if (ready.length) initiation = this.#issue(state, ready[0], capabilityId, now, false);
        // Nothing for anybody: her own wake-up may be due (a request to a person always goes first).
        else {
          const wake = this.#wakeNext(capabilityId, { busy: input.busy === true, quiet, world, now, state });
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
      if (item.source === 'reach') this.#reachEnded(state, item, now, this.worldStatus());
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
  /** Operator only; any of:
   * - `quietHours:{from:'HH:MM',to:'HH:MM'}`: Beijing wall-clock times (equal ends mean no quiet hours; no console
   *   form uses it yet: scenario replay does, to run at any hour).
   * - `wake:{enabled?,times?}`: her private wake-up (off until the operator turns it on) and its one or two times of
   *   day `['HH:MM',...]`.
   * - `reach:{enabled?,people?,recentMinutes?,fuses?}`: whether a wake-up may lead to a turn she starts (off until
   *   turned on); `people` `{<opaque label>: boolean}`, one person's switch (off for everyone but the owner until
   *   turned on); how recent a chat keeps a person out (0..1440 minutes); the four high fuses of wake.js (1..1000). */
  initiationSettings(input) {
    closed(input, ['quietHours', 'wake', 'reach'], []);
    if (input.quietHours === undefined && input.wake === undefined && input.reach === undefined) fail('VALIDATION_ERROR', 'Nothing to change');
    const minuteOf = value => { const match = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null; if (!match) fail('VALIDATION_ERROR', 'Times are HH:MM'); return Number(match[1]) * 60 + Number(match[2]); };
    let minutes = null, times = null;
    if (input.quietHours !== undefined) {
      closed(input.quietHours, ['from', 'to']);
      minutes = ['from', 'to'].map(key => minuteOf(input.quietHours[key]));
    }
    if (input.wake !== undefined) {
      closed(input.wake, ['enabled', 'times'], []);
      if (input.wake.enabled !== undefined && typeof input.wake.enabled !== 'boolean') fail('VALIDATION_ERROR', 'enabled must be boolean');
      if (input.wake.times !== undefined) {
        if (!Array.isArray(input.wake.times) || input.wake.times.length < 1 || input.wake.times.length > WAKE.maxTimes) fail('VALIDATION_ERROR', 'times holds one or two times of day');
        times = input.wake.times.map(minuteOf).sort((a, b) => a - b);
        if (new Set(times).size !== times.length) fail('VALIDATION_ERROR', 'times must differ');
      }
    }
    const reach = input.reach;
    if (reach !== undefined) {
      closed(reach, ['enabled', 'people', 'recentMinutes', 'fuses'], []);
      if (reach.enabled !== undefined && typeof reach.enabled !== 'boolean') fail('VALIDATION_ERROR', 'enabled must be boolean');
      if (reach.recentMinutes !== undefined && !(Number.isInteger(reach.recentMinutes) && reach.recentMinutes >= 0 && reach.recentMinutes <= 1440)) fail('VALIDATION_ERROR', 'recentMinutes is out of range');
      if (reach.fuses !== undefined) { closed(reach.fuses, Object.keys(REACH.fuses), []); if (Object.values(reach.fuses).some(value => !(Number.isInteger(value) && value >= 1 && value <= FUSE_MAX))) fail('VALIDATION_ERROR', 'A fuse is out of range'); }
      if (reach.people !== undefined) { closed(reach.people, Object.keys(reach.people ?? {})); if (Object.values(reach.people).some(value => typeof value !== 'boolean')) fail('VALIDATION_ERROR', 'A person switch must be boolean'); }
    }
    return this.store.transaction(() => {
      const state = this.#state(), now = this.now();
      if (minutes) { state.quiet = { fromMinute: minutes[0], toMinute: minutes[1] }; this.#save(state); }
      const own = this.#initiative();
      if (input.wake) {
        own.wake = { enabled: input.wake.enabled ?? this.#wakeSettings(own).enabled, minutes: times ?? this.#wakeSettings(own).minutes };
        // New times: scheduled afresh from now on (a time of today that has passed is not made up for).
        if (times) { delete own.nextAt; own.slotAt = now; }
      }
      if (reach) {
        const stored = own.reach ||= {};
        if (reach.enabled !== undefined) stored.enabled = reach.enabled;
        if (reach.recentMinutes !== undefined) stored.recentMinutes = reach.recentMinutes;
        if (reach.fuses) stored.fuses = { ...stored.fuses, ...reach.fuses };
        if (reach.people) {
          // A label names a person only among those who can be reached at all; the request never carries a person ID.
          const entityId = this.#recentStream(OWNER)?.entityId, known = new Map((entityId ? this.#people(entityId) : []).map(personId => [opaquePerson(personId), personId]));
          for (const [label, enabled] of Object.entries(reach.people)) {
            if (!known.has(label)) fail('VALIDATION_ERROR', 'Unknown person');
            ((stored.people ||= {})[known.get(label)] ||= {}).enabled = enabled;
          }
        }
      }
      if (input.wake || reach) this.#saveInitiative(own);
      const quiet = this.#quiet(state), wake = this.#wakeSettings(own);
      return {
        quietHours: { from: clock(quiet.fromMinute), to: clock(quiet.toMinute), timezone: 'Asia/Shanghai', now: quietHours(now, quiet) },
        ...(input.wake ? { wake: { enabled: wake.enabled, times: wake.minutes.map(clock) } } : {}), ...(reach ? { reach: this.#reachView(own, now) } : {}),
      };
    });
  }



  // ---- Her private wake-up and reaching out from it (wake.js). ----
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
  /** The switch and the times of day (minutes of the Beijing day). What an earlier release stored (`perDay`) is ignored. */
  #wakeSettings(own) {
    const minutes = own.wake?.minutes;
    return { enabled: own.wake?.enabled === true, minutes: Array.isArray(minutes) && minutes.length >= 1 && minutes.length <= WAKE.maxTimes && minutes.every(validMinute) ? minutes : [...WAKE.minutes] };
  }
  /** Reaching out: the switch (off until the operator turns it on), how recent a chat keeps a person out, the fuses. */
  #reachSettings(own) {
    const stored = own.reach ?? {}, valid = value => Number.isInteger(value) && value >= 1 && value <= FUSE_MAX;
    return {
      enabled: stored.enabled === true, recentMs: Number.isInteger(stored.recentMinutes) && stored.recentMinutes >= 0 && stored.recentMinutes <= 1440 ? stored.recentMinutes * MINUTE : REACH.recentMs,
      fuses: Object.fromEntries(Object.entries(REACH.fuses).map(([name, limit]) => [name, valid(stored.fuses?.[name]) ? stored.fuses[name] : limit])),
    };
  }
  /** One person's switch: off until the operator turns it on, except the owner's own, which is on until turned off. */
  #switchOn(own, personId) { const set = own.reach?.people?.[personId]?.enabled; return typeof set === 'boolean' ? set : personId === OWNER; }
  /** Everyone with an account and a private conversation on a conversation channel (her own conversation is nobody's). */
  #people(entityId) {
    return this.store.db.prepare(`SELECT DISTINCT s.person_id AS personId FROM streams s JOIN capabilities c ON c.id=s.capability_id AND c.policy='conversation.v1'
      WHERE s.audience='private' AND s.entity_id=? AND s.person_id<>? AND EXISTS (SELECT 1 FROM actors a WHERE a.capability_id=s.capability_id AND a.person_id=s.person_id) ORDER BY s.person_id`).all(entityId, SELF_PERSON).map(row => row.personId);
  }
  #boundary(entityId, personId, now) {
    return !!this.store.db.prepare("SELECT 1 FROM memory_items WHERE entity_id=? AND person_id=? AND collection='appraisals' AND kind='boundary' AND status='active' AND json_extract(body,'$.evidence.at')>=? LIMIT 1").get(entityId, personId, now - REACH.boundaryMs);
  }
  /** The soft facts about one person: times and counts from their private conversations, and her own reach-outs to
   * them from the lasting record (`own.reach.people`), which does not depend on how many requests are still kept.
   * "Unanswered" is over once the person has written after her last reach-out. */
  #personStats(own, entityId, personId, now) {
    const row = this.store.db.prepare(`SELECT MIN(json_extract(o.body,'$.at')) AS firstAt,MAX(json_extract(o.body,'$.at')) AS lastAt,
      MAX(CASE WHEN json_extract(o.body,'$.role')='user' THEN json_extract(o.body,'$.at') END) AS lastUserAt,
      COALESCE(SUM(json_extract(o.body,'$.role')='user' AND json_extract(o.body,'$.at')>=?),0) AS lines14
      FROM observations o JOIN streams s ON s.capability_id=o.capability_id AND s.stream_id=o.stream_id WHERE s.person_id=? AND s.audience='private' AND s.entity_id=? AND o.forgotten=0`).get(now - REACH.chatterMs, personId, entityId);
    const record = own.reach?.people?.[personId] ?? {}, reachedAt = Number.isSafeInteger(record.lastAt) ? record.lastAt : null;
    return {
      firstAt: row.firstAt, lastAt: row.lastAt, lastUserAt: row.lastUserAt, lines14: row.lines14, reachedAt,
      unanswered: reachedAt === null || (row.lastUserAt ?? 0) > reachedAt ? 0 : record.unanswered ?? 0,
      reached7: (record.ats ?? []).filter(at => at >= now - REACH.reachedMs).length,
    };
  }
  /** Why she may not reach out to this person as things stand (a forced rule: not a fault), or null. */
  #reachRefusal(own, entityId, personId, now) {
    const today = beijingDay(now);
    return !this.#reachSettings(own).enabled ? 'reach_off' : !this.#switchOn(own, personId) ? 'switch' : own.fuse?.day === today ? 'fuse' : own.deferredDay === today ? 'budget'
      : this.#boundary(entityId, personId, now) ? 'boundary' : !this.#recentStream(personId) ? 'target' : null;
  }
  /** The cards of one wake-up: one for every person she may reach out to now, and how many people were left out, by
   * reason. Nobody is a candidate while reaching out is switched off. */
  #cards(own, entityId, now) {
    const settings = this.#reachSettings(own), cards = [], excluded = {};
    let chars = 0;
    for (const personId of this.#people(entityId)) {
      const stats = this.#personStats(own, entityId, personId, now);
      const reason = this.#reachRefusal(own, entityId, personId, now) ?? (stats.lastAt !== null && now - stats.lastAt < settings.recentMs ? 'recent' : null);
      const digests = [];
      let left = REACH.digestChars, text = '';
      if (!reason) {
        // Machine digests of this person's dialogue: the newest one or two, 200 characters between them; one the
        // sensitive lexicon matches is left out, as it is from her diary's material.
        for (const memory of this.recentDigests(entityId, personId, REACH.digests)) {
          const summary = String(memory.summary ?? '');
          if (!summary || left < 20 || SENSITIVE.test(summary)) continue;
          const shown = clip(summary, left);
          left -= [...shown].length; digests.push({ day: beijingDay(memory.toAt), summary: shown });
        }
        text = renderCard({ label: opaquePerson(personId), stats, intents: this.openIntents(entityId, personId), digests }, now);
      }
      const leftOut = reason ?? (cards.length >= REACH.cards || chars + text.length > REACH.cardsChars ? 'budget' : null);
      if (leftOut) { excluded[leftOut] = (excluded[leftOut] ?? 0) + 1; continue; }
      chars += text.length; cards.push({ personId, label: opaquePerson(personId), text });
    }
    return { cards, excluded };
  }
  /** Which high fuse one more reach-out to this person would hit, or null. Counted from the lasting record of what
   * went out (or may have) plus the requests still open. */
  #fuse(own, items, personId, now) {
    const limits = this.#reachSettings(own).fuses, day = beijingMidnight(now);
    const sent = [...Object.entries(own.reach?.people ?? {}).flatMap(([id, record]) => (record.ats ?? []).map(at => ({ personId: id, at }))),
      ...items.filter(item => item.source === 'reach' && item.status !== 'closed').map(item => ({ personId: item.personId, at: item.createdAt }))];
    const mine = sent.filter(item => item.personId === personId);
    return sent.filter(item => item.at >= day).length >= limits.per_day ? 'per_day' : mine.filter(item => item.at >= day).length >= limits.per_person_day ? 'per_person_day'
      : mine.filter(item => item.at >= now - REACH.reachedMs).length >= limits.per_person_week ? 'per_person_week' : sent.filter(item => item.at >= now - 60 * MINUTE).length >= limits.per_hour ? 'per_hour' : null;
  }
  /** A high fuse was hit: a fault, not a limit. It is counted in the day's log, and the first one of a Beijing day
   * stops everything she starts for the rest of that day and tells the owner once: a fixed notice, registered here
   * and sent by the bridge without any model. */
  #tripFuse(own, log, items, name, now, world) {
    const day = beijingDay(now);
    this.#skip(log, `fuse:${name}`, now);
    if (own.fuse?.day === day) return;
    own.fuse = { day, name, at: now };
    const target = this.#recentStream(OWNER);
    if (target) items.push({
      id: randomUUID(), kind: 'notice', source: 'fuse', notice: 'fuse', capabilityId: target.capabilityId, streamId: target.streamId, personId: OWNER, entityId: target.entityId,
      memoryEpoch: this.streamEpoch(this.entity(target.entityId), target.capabilityId, target.streamId), worldRevision: world.revision, createdAt: now, expiresAt: now + REACH.ttlMs, status: 'waiting',
    });
  }
  /** A request from a wake-up was closed: what that means for the lasting record. One that went out (or may have:
   * `unknown`) counts as a reach-out to that person; one that was delivered settles the intents it showed her that
   * were due; the wake-up's log entry gets the outcome. Loads and saves her own state itself. */
  #reachEnded(state, item, now, world) {
    const own = this.#initiative(), log = this.#wakeLog(), outcome = item.outcome;
    if (['sent', 'partial', 'unknown'].includes(outcome) && !item.counted) {
      const record = ((own.reach ||= {}).people ||= {})[item.personId] ||= {}, stats = this.#personStats(own, item.entityId, item.personId, now);
      record.unanswered = stats.unanswered + 1; record.lastAt = now;
      record.ats = [...(record.ats ?? []).filter(at => at >= now - REACH.reachedMs), now];
      item.counted = true;
    }
    if (['sent', 'partial'].includes(outcome)) for (const id of item.intentIds ?? []) this.settleIntentNow(item.entityId, id);
    if (outcome === 'deferred:budget') own.deferredDay = beijingDay(now);
    // The bridge refused to send more messages in one turn than the fuse allows.
    if (outcome === 'dropped:fuse_messages') this.#tripFuse(own, log, state.items, 'messages_per_turn', now, world);
    const shown = log.find(entry => entry.type === 'wake' && entry.id === item.wakeId)?.reach?.find(entry => entry.initiationId === item.id);
    if (shown) shown.outcome = outcome;
    this.#saveInitiative(own); this.#saveWakeLog(log);
  }
  /** What the people she may reach out to wrote lately (their own lines, not forgotten): a reason may not repeat them. */
  #words(entityId, personIds, now) {
    if (!personIds.length) return [];
    return this.store.db.prepare(`SELECT json_extract(o.body,'$.text') AS text FROM observations o JOIN streams s ON s.capability_id=o.capability_id AND s.stream_id=o.stream_id
      WHERE s.audience='private' AND s.entity_id=? AND s.person_id IN (${personIds.map(() => '?').join(',')}) AND o.forgotten=0 AND json_extract(o.body,'$.role')='user' AND json_extract(o.body,'$.at')>=? ORDER BY o.rowid DESC LIMIT 400`)
      .all(entityId, ...personIds, now - REACH.chatterMs).map(row => row.text).filter(text => typeof text === 'string');
  }
  /** Wake-ups that ran (or may have) on the Beijing day of `now`: one the spend tier refused or the bridge never started does not count. */
  #wokeToday(log, now) {
    const day = beijingDay(now);
    return log.filter(entry => entry.type === 'wake' && beijingDay(entry.at) === day && entry.outcome !== 'deferred:budget' && !entry.outcome.startsWith('dropped:')).length;
  }
  /** A wake-up that was due and did not happen (or a fuse that was hit): counted by reason, merged into one entry a Beijing day. */
  #skip(log, reason, now) {
    const day = beijingDay(now);
    let entry = log.findLast(item => item.type === 'skip' && item.day === day);
    if (!entry) { entry = { type: 'skip', day, at: now, counts: {} }; log.push(entry); }
    entry.counts[reason] = (entry.counts[reason] ?? 0) + 1; entry.at = now;
  }
  /** What would stop a wake-up as things stand (the bridge being busy aside), or null. */
  #wakeBlocked(own, world, quiet, now) {
    const today = beijingDay(now);
    return world.paused ? 'paused' : quietHours(now, quiet) ? 'quiet_hours' : own.deferredDay === today ? 'budget' : own.fuse?.day === today ? 'fuse' : null;
  }
  /** Is her wake-up due on this channel, and may it happen now? Returns the request to hand out, 'out' while one is
   * out, or null. Only the channel the owner last spoke on carries wake-ups (so one bridge runs them). Decided here
   * and nowhere else: the caller only says whether it has turns queued. A wake-up that is due and may not happen is
   * counted with its reason and not made up for (a busy bridge only puts it off by a few minutes). */
  #wakeNext(capabilityId, { busy, quiet, world, now, state }) {
    const target = this.#recentStream(OWNER);
    if (!target || target.capabilityId !== capabilityId) return null;
    const own = this.#initiative(), stored = JSON.stringify(own), log = this.#wakeLog(), logged = JSON.stringify(log), random = this.random ?? Math.random;
    const done = value => { if (JSON.stringify(own) !== stored) this.#saveInitiative(own); if (JSON.stringify(log) !== logged) this.#saveWakeLog(log); return value; };
    if (own.out) {
      if (now - own.out.issuedAt < INITIATION.reportMs) return done('out');
      // Fetched and never reported: what became of it is unknown, and nobody is reached out to from it. The bridge's
      // own report may still replace the outcome.
      this.#wakeEnd(own, log, 'unknown', now, state, world, { unreported: true });
    }
    const settings = this.#wakeSettings(own), manual = own.manualAt !== undefined;
    if (!settings.enabled) {
      // Off: nothing is scheduled; only a wake-up the operator asked for is counted.
      if (manual) this.#skip(log, 'off', now);
      delete own.manualAt; delete own.nextAt; delete own.slotAt; delete own.holdUntil;
      return done(null);
    }
    // (A `nextAt` without its `slotAt` is the schedule of a release before this one: it is replaced.)
    const schedule = () => { const next = nextWake(now, settings.minutes, own.slotAt, random); own.nextAt = next.at; own.slotAt = next.slot; };
    if (!Number.isSafeInteger(own.nextAt) || !Number.isSafeInteger(own.slotAt)) schedule();
    // Nobody asked while it was due (the bridge was down, or busy all along): an hour past its time it is missed.
    if (now > own.slotAt + 2 * WAKE.jitterMs) { this.#skip(log, 'missed', now); schedule(); }
    const scheduled = now >= own.nextAt;
    if (!manual && !scheduled || now < (own.holdUntil ?? 0)) return done(null);
    delete own.holdUntil;
    const streamId = selfStream(capabilityId), reason = manual ? 'manual' : 'schedule';
    const bound = this.store.db.prepare('SELECT person_id AS personId,audience,entity_id AS entityId FROM streams WHERE capability_id=? AND stream_id=?').get(capabilityId, streamId);
    const blocked = this.#wakeBlocked(own, world, quiet, now) ?? (busy ? 'busy' : bound && (bound.personId !== SELF_PERSON || bound.audience !== 'private') ? 'target' : null);
    if (blocked === 'busy') { this.#skip(log, blocked, now); own.holdUntil = now + WAKE.busyRetryMs; return done(null); }
    // From here on what was due is used up, whether or not she wakes.
    delete own.manualAt; if (scheduled) delete own.nextAt;
    if (blocked) { this.#skip(log, blocked, now); return done(null); }
    if (this.#wokeToday(log, now) >= WAKE.fuseWakesPerDay) { this.#tripFuse(own, log, state.items, 'wakes_per_day', now, world); return done(null); }
    // Her own conversation on this channel: bound to the reserved person, who is nobody.
    const entityId = bound?.entityId ?? target.entityId;
    if (!bound) {
      this.store.db.prepare('INSERT INTO streams(capability_id,stream_id,person_id,audience,entity_id) VALUES(?,?,?,?,?)').run(capabilityId, streamId, SELF_PERSON, 'private', entityId);
      this.adminAudit('stream.bind', { capabilityId, streamId, personId: SELF_PERSON, audience: 'private', entityId });
    }
    const entity = this.entity(entityId), cardId = this.currentCardId(entityId), midnight = beijingMidnight(now);
    // Her diary and her mood are subjective memory: only what was written under the persona card now current is read back.
    const diary = this.latestPrivateDiary(entityId, cardId), mood = (own.moods ?? []).findLast(item => (item.cardId ?? DEFAULT_CARD_ID) === cardId) ?? null;
    const { cards, excluded } = this.#cards(own, entityId, now);
    const reachedToday = Object.values(own.reach?.people ?? {}).filter(record => (record.ats ?? []).some(at => at >= midnight)).length;
    // `candidates` (label -> person) stays here: it is what `reach` is held against, and it is never shown or logged.
    own.out = { id: randomUUID(), capabilityId, streamId, entityId, memoryEpoch: this.streamEpoch(entity, capabilityId, streamId), issuedAt: now, reason,
      counts: { cards: cards.length, excluded, diary: !!diary, mood: !!mood }, candidates: Object.fromEntries(cards.map(card => [card.label, card.personId])), did: {} };
    own.lastWakeAt = now;
    return done({ id: own.out.id, kind: 'wake', streamId, memoryEpoch: own.out.memoryEpoch, expiresAt: now + INITIATION.ttlMs,
      briefing: renderBriefing({ now, reason, diary, mood: mood && { text: mood.text, at: mood.at }, cards: cards.map(card => card.text), reachedToday }) });
  }
  /** A wake-up ends: one log entry. After one that ran, each person she named and Authority accepted is held against
   * the forced rules and the fuses once more, and a request to that person is registered (`state.items`; the caller
   * saves it). The log keeps the label, the result of the checks and, for an accepted one, her reason as it was kept. */
  #wakeEnd(own, log, outcome, now, state, world, { unreported = false } = {}) {
    const out = own.out; delete own.out;
    const reach = (out.reach ?? []).map(({ personId, ...shown }) => shown);
    const entry = { id: out.id, type: 'wake', at: out.issuedAt, endedAt: now, reason: out.reason, outcome, counts: out.counts, did: { ...out.did, rested: outcome === 'done' && !Object.keys(out.did).length }, reach, fuses: [], ...(unreported ? { unreported: true } : {}) };
    for (const [index, item] of (out.reach ?? []).entries()) {
      if (item.check !== 'accepted') continue;
      const shown = reach[index];
      if (outcome !== 'done') { shown.check = 'rejected:wake_not_done'; continue; }
      const refused = this.#reachRefusal(own, out.entityId, item.personId, now);
      if (refused) { shown.check = `rejected:${refused}`; continue; }
      const fuse = this.#fuse(own, state.items, item.personId, now);
      if (fuse) { entry.fuses.push(`fuse:${fuse}`); shown.check = `rejected:fuse:${fuse}`; this.#tripFuse(own, log, state.items, fuse, now, world); continue; }
      const target = this.#recentStream(item.personId);
      const request = {
        id: randomUUID(), kind: 'proactive', source: 'reach', wakeId: out.id, capabilityId: target.capabilityId, streamId: target.streamId, personId: item.personId, entityId: target.entityId,
        memoryEpoch: this.streamEpoch(this.entity(target.entityId), target.capabilityId, target.streamId), worldRevision: world.revision,
        afterRow: this.store.db.prepare('SELECT MAX(rowid) AS n FROM observations').get().n ?? 0, createdAt: now, expiresAt: now + REACH.ttlMs, status: 'waiting', reason: item.reason,
      };
      state.items.push(request); shown.initiationId = request.id; shown.outcome = null;
    }
    // The gateway's spend tier refused the run: no wake-up for the rest of that Beijing day.
    if (outcome === 'deferred:budget') own.deferredDay = beijingDay(now);
    log.push(entry);
  }
  /** The bridge's report about a wake-up, or null when `input.id` is not one. Reported once, like any request. */
  #wakeAck(capabilityId, input, now, state) {
    const own = this.#initiative(), log = this.#wakeLog(), wakeOutcome = WAKE_OUTCOMES.includes(input.outcome) || DROPPED.test(input.outcome);
    if (own.out?.id === input.id) {
      if (own.out.capabilityId !== capabilityId) fail('CONFLICT', 'Initiation is not out', 409);
      if (!wakeOutcome) fail('VALIDATION_ERROR', 'Unsupported wake outcome');
      this.#wakeEnd(own, log, input.outcome, now, state, this.worldStatus());
      this.#saveInitiative(own); this.#saveWakeLog(log); this.#save(state);
      return { status: 'recorded' };
    }
    const entry = log.find(item => item.type === 'wake' && item.id === input.id);
    if (!entry) return null;
    if (entry.outcome === input.outcome) return { status: 'recorded', replayed: true };
    if (!entry.unreported || !wakeOutcome) fail('CONFLICT', 'Initiation was already reported', 409);
    // Closed for want of a report, and the report came after all (what she did in it is already in the entry; nobody
    // is reached out to from a wake-up that was closed this way).
    entry.outcome = input.outcome; entry.endedAt = now; delete entry.unreported;
    if (input.outcome === 'deferred:budget') { own.deferredDay = beijingDay(now); this.#saveInitiative(own); }
    this.#saveWakeLog(log);
    return { status: 'recorded' };
  }
  /** A conversation channel's credential, from inside the wake-up that is out on that channel (the model tool
   * `companion_self`): what she writes down for herself, and whom she wants to reach out to.
   * `{streamId,mood?,note?,reach?}`; the conversation must be the one the wake-up was handed out for. A mood (<=120
   * characters) and a note (<=400) pass the checks of a machine digest or are refused with the reason; they are read
   * by the operator's page and her next briefing (the mood) only.
   * `reach`: at most two `{label,reason}`. Each is checked here and now, and she is told `accepted` or
   * `rejected:<reason>`: the label must be one of this wake-up's cards (`not_candidate`; twice the same, `duplicate`);
   * in the reason the person's own label becomes "对方" and any other label "另一个人"; then the reason must pass
   * `refusedReason` (the sensitive lexicon and the categories of wake.js) and may not repeat a run of words any
   * candidate wrote lately (`sensitive:quote`). A refused entry is dropped whole: its reason is not kept anywhere.
   * A later `reach` in the same wake-up replaces the earlier one. Nothing is registered until the wake-up ends. */
  selfRecord(capabilityId, input) {
    closed(input, ['streamId', 'mood', 'note', 'reach'], ['streamId']); identifier(input.streamId);
    for (const key of ['mood', 'note']) if (input[key] !== undefined && typeof input[key] !== 'string') fail('VALIDATION_ERROR', `${key} must be a string`);
    if (input.reach !== undefined) {
      if (!Array.isArray(input.reach) || input.reach.length > REACH.perWake) fail('VALIDATION_ERROR', 'reach names at most two people');
      for (const item of input.reach) { closed(item, ['label', 'reason']); if (typeof item.label !== 'string' || item.label.length > 64 || typeof item.reason !== 'string' || item.reason.length > 2000) fail('VALIDATION_ERROR', 'reach entries are {label,reason}'); }
    }
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
      if (input.reach !== undefined) {
        const candidates = out.candidates ?? {}, words = this.#words(out.entityId, Object.values(candidates), now), seen = new Set();
        out.reach = input.reach.map(({ label, reason }) => {
          // A label that is not a candidate is logged as given only when it has the shape of one.
          const person = /^p-[0-9a-f]{6}$/.test(label) ? label : null, personId = Object.hasOwn(candidates, label) ? candidates[label] : null;
          if (!personId) return { person, check: 'rejected:not_candidate' };
          if (seen.has(label)) return { person, check: 'rejected:duplicate' };
          seen.add(label);
          const kept = withoutLabels(reason, label), refused = refusedReason(kept) ?? (repeatsWords(kept, words) ? 'sensitive:quote' : null);
          return refused ? { person, ...(personId === OWNER ? { owner: true } : {}), check: `rejected:${refused}` } : { person, ...(personId === OWNER ? { owner: true } : {}), personId, check: 'accepted', reason: kept };
        });
        result.reach = out.reach.map(item => item.check); out.did.reach = out.reach.length;
      }
      this.#saveInitiative(own);
      return result;
    });
  }
  /** Operator only: wake her now. Every rule still applies when the bridge next asks (the switch, a pause, the quiet
   * hours, the spend tier, a fuse hit today, a busy bridge); `blocked` is what would stop it as things stand. The
   * request names nothing and nobody. */
  initiativeWake(input = {}) {
    closed(input, [], []);
    return this.store.transaction(() => {
      const own = this.#initiative(), now = this.now();
      own.manualAt = now;
      this.#saveInitiative(own);
      return { scheduledAt: now, blocked: !this.#wakeSettings(own).enabled ? 'off' : this.#wakeBlocked(own, this.worldStatus(), this.#quiet(this.#state()), now) };
    });
  }
  /** What the operator sees of the two switches and of each person (opaque labels, times and counts; no text). */
  #reachView(own, now) {
    const settings = this.#reachSettings(own), entityId = this.#recentStream(OWNER)?.entityId, open = entityId ? this.openIntentCounts({ entityId }) : {};
    return {
      enabled: settings.enabled, recentMinutes: settings.recentMs / MINUTE, fuses: settings.fuses,
      people: (entityId ? this.#people(entityId) : []).map(personId => {
        const stats = this.#personStats(own, entityId, personId, now);
        return { person: opaquePerson(personId), owner: personId === OWNER, enabled: this.#switchOn(own, personId), lastAt: stats.lastAt, reachedAt: stats.reachedAt, unanswered: stats.unanswered, reached7: stats.reached7, openIntents: open[personId] ?? 0 };
      }).sort((a, b) => b.owner - a.owner || (a.person < b.person ? -1 : 1)),
    };
  }
  /** Operator only, read-only: the switches, the times of day and the schedule, each person's switch and soft facts,
   * her moods and notes (her own words, newest first), and the wake log, newest first: when and why she woke, how
   * many cards she was given, what she did, whom she named, what the checks said and what became of each request.
   * Opaque labels only; no message text, no intent text, no account. */
  initiativeView() {
    this.store.check();
    const own = this.#initiative(), log = this.#wakeLog(), now = this.now(), settings = this.#wakeSettings(own);
    const newest = list => [...(list ?? [])].reverse().map(({ text, at, wakeId, cardId }) => ({ text, at, wakeId, cardId: cardId ?? DEFAULT_CARD_ID }));
    return {
      wake: { enabled: settings.enabled, times: settings.minutes.map(clock), maxTimes: WAKE.maxTimes, jitterMinutes: WAKE.jitterMs / MINUTE },
      reach: this.#reachView(own, now), fuse: own.fuse?.day === beijingDay(now) ? { name: own.fuse.name, at: own.fuse.at } : null,
      nextAt: settings.enabled && Number.isSafeInteger(own.nextAt) && Number.isSafeInteger(own.slotAt) ? own.nextAt : null, lastWakeAt: own.lastWakeAt ?? null, out: own.out ? { id: own.out.id, issuedAt: own.out.issuedAt } : null,
      wokeToday: this.#wokeToday(log, now), moods: newest(own.moods), notes: newest(own.notes),
      log: [...log].sort((a, b) => b.at - a.at),
    };
  }
}
