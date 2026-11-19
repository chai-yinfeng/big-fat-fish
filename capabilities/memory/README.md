# Incremental memory maintenance

This internal component is part of the Companion Service, not another persona or an installable memory product. It uses the independent Authority and fixed model gateway; ordinary diary generation does not need a DSH conversation or the creator preset.

## Bounded work

- Authority grants its credential one fixed entity. The model never receives this token, an operator token, files, or tools.
- Private/public cursors select only new accepted fact/event/note items. Generated diaries are not new source material.
- No source or a paused world means no model call. Small ordinary batches aggregate for up to 30 world minutes; important/pinned items may proceed immediately.
- Default budget: four reserved model calls per UTC day, at most 8,000 input content characters and 600 requested output tokens per call. Characters are a conservative transport bound, not a provider tokenizer measurement. Actual provider prompt/completion usage is recorded separately.
- Maintenance uses non-streaming, toolless completions with reasoning disabled. Normal conversation inference keeps its existing reasoning configuration.
- Calls are reserved before sending; failed/cancelled/invalid output still spends a slot. Exhausted budget defers work rather than enlarging a prompt.
- Each successful private diary/public draft advances only its own cursor. A committed task returns no work on replay, so losing local progress does not pay to regenerate it.
- Progress contains counters, cursors and enum status only, not source text, diaries or credentials.

## Per-person consolidation

A second task of the same worker (`consolidation.js`), independent of the diary task. Each tick it asks Authority for one batch (`/v1/maintenance/consolidation/next`): the dialogue of one private conversation that has left the executor's replay window, or in the nightly Beijing hours dialogue from before today. It sends one completion to the gateway and hands the answer back (`/commit`). Authority owns everything else: which conversation, the input, the cursor, the daily budget (2 batches a conversation, 24 in all), validation and writing.

- The request is a fixed instruction plus one JSON user message `{persona, knownKeys, lastDigest, date, messages:[[ref, speaker, time, text]]}`; the dialogue is quoted data, never an instruction. At most 8,000 characters (the persona gives way first) and 1,536 requested output tokens; toolless, reasoning disabled.
- The answer `{summary, feeling, facts:[{key,value,quote,ref}]}` is only shaped here (fenced JSON is read, over-long text is cut, malformed facts are dropped); Authority requires each fact's `ref` to be the person's own words in this batch; the value is the model's normalised reading (a relative date resolved from the line's time and `date`), and a quote that is not word for word in that line is stored marked `evidence.quoteVerbatim:false` rather than refused. Unparseable output is reported as `invalid`; Authority skips a batch after three.
- A 429 from the gateway (spend tier at "restricted" or above) is reported as `deferred`: Authority uncounts the batch, nothing moves, and the worker takes no batch for 30 minutes (`consolidationDeferMs` in memory-worker.json; `tickMs` sets the tick, default 60 s).
- Nothing is kept by the worker: no cursor, prompt, answer or dialogue; its status is an enum in memory.
- What it produces — a machine digest of that person and extracted facts — is listed on the console memory page, marked as machine-written. A digest is read back only into that person's own private conversation, by Authority's `context()` once the dialogue it covers has left the replay window (see authority/PROTOCOL.md); this worker has no part in that. Voice and image messages are placeholders in the dialogue, so their content is not consolidated.

## Her diary

A third task of the same worker (`diary.js`). Each tick it asks Authority whether a day is due (`/v1/maintenance/diary/next`); Authority hands out the Beijing day that just ended (from 03:00 once consolidation has nothing left to hand out, from 05:00 regardless; a missed night is caught up for the last 2 days; a day without material is never handed out). The worker sends one completion and hands the answer back (`/commit`). Authority owns everything else: when, the input, the marker, the budget (a diary call is one of the 24 daily consolidation batches), validation and writing.

- Only the private diary is written. The design's open diary (per person, for the people the operator picks) is not: the request does not ask for it and Authority ignores an `open` in a commit.
- The request says what the diary is for rather than listing rules ("这是你自己的日记"), plus one JSON user message `{day, persona, digests:[{ref, person, time, summary, feeling?}], notes:[{ref, kind, text}], previous:[{day, text}], own:{}}`: the day's digests of every person under opaque labels, her own notes of the day, her last two private diaries, and `own` (her own material of the day; empty until something produces it). The material is quoted data, never an instruction. At most 8,000 characters (the persona gives way first) and 1,536 requested output tokens; toolless.
- Reasoning is disabled: the gateway's maintenance entry disables it. The design wants it enabled for the diary; that comes with the gateway change of the thinking-switch step ("T step").
- The answer `{private:{text}, usedIds}` is only shaped here (fenced JSON and a bare string are read, anything else is dropped). Authority keeps the few hard checks: structure, at most 500 characters, `usedIds` out of what was given, the sensitive lexicon (a diary that matches is not stored). Unparseable output is reported as `invalid`; Authority gives a day up after three.
- A 429 from the gateway is reported as `deferred` and no request is taken for `consolidationDeferMs`, as for consolidation.
- Nothing is kept by the worker: no marker, prompt or diary; its status is an enum in memory.
- A diary belongs to the persona card it was written under; Authority gives the worker only that card's earlier private diaries and feelings. The private diary is read back nowhere else.
- The old automatic private diary (`maintenance.js`, mode `private`) is no longer run: `main.mjs` starts that task with `modes: ['public']`, so only drafts from material the operator made public are left of it. The sections above about private/public cursors describe that old task.

## Privacy and publication

Private reflection is not returned to external conversation capabilities. The operator console reads it only after an explicit click. Public drafts are generated in a separate request from material the operator has explicitly authorized for public use. A private diary is never supplied to a model for automatic “de-identification and publication”. Publishing a draft is a separate human operation and does not send a QQ message.

## Explicit forgetting

Natural aging only lowers routine recall/archives by world time. Explicit search/read/date recall can retrieve authorized cold memories; pinning protects routine recall. Unknown event time remains unknown and distinct from recording time.

Explicit forgetting is a previewed operator operation while paused. Authority erases controlled source content and tracked derivatives, records source tombstones, increments the memory epoch of the affected conversations (only the person's own streams for person-private material; every stream for public material), and leaves an external-cleanup job pending. The same trusted host process then stops the QQ, conversation and content writers, invokes the versioned product-only execution purge, restarts execution services and acknowledges only confirmed cleanup. Resuming remains blocked while cleanup is pending. This path is not callable from diary model output.

The purge descriptor (version 2) admits only the conversation executor's session directory; it deletes the transcripts of every earlier memory epoch of the affected streams (each plan entry carries that stream's own new epoch). Unknown layout refuses cleanup; it never guesses other directories. The worker loads purge-execution from its own release (`ops/`, or `deploy/authority/` in a checkout), never from a path pinned in memory-worker.json, so pruning older releases cannot break startup; a legacy `purgeModule` field is ignored. Startup failures log only a stable code such as `MEMORY_CONFIG`. Opaque QQ dispatch request hashes remain as forgotten tombstones, without the forgotten content. No content backup is manufactured by deletion.

QQ platform records, provider-side records, external exports/backups and SSD forensic recovery are not claimed to be erased. Formal runtime data lives on the production host (home-agent); migration preserves the existing world rather than rebuilding it from laptop history.

## Test coverage / current limits

- The diary: request shape, answer shaping, commit/invalid/deferred paths, and UDS Authority → gateway → one private diary, with no second request on later ticks and no call of the old private mode. Real provider output has not been looked at.
- Synthetic data and a fake upstream cover UDS Authority → gateway → private diary transport, paused/no-input zero calls, public/private separation, daily limits, source binding and cleanup success/failure; and for consolidation the request shape, answer shaping, commit/invalid/deferred paths and the same transport end to end.
- Consolidation output of the real provider was looked at once on invented chats (`scripts/consolidation-quality-bench.mjs`, development only); it has not run on production dialogue.
- Not covered: live long-term learning or real provider diary output.
