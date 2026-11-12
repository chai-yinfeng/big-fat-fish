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
- What it produces — a machine digest of that person and extracted facts — is listed on the console memory page, marked as machine-written. Digests are not read back into any conversation yet. Voice and image messages are placeholders in the dialogue, so their content is not consolidated.

## Privacy and publication

Private reflection is not returned to external conversation capabilities. The operator console reads it only after an explicit click. Public drafts are generated in a separate request from material the operator has explicitly authorized for public use. A private diary is never supplied to a model for automatic “de-identification and publication”. Publishing a draft is a separate human operation and does not send a QQ message.

## Explicit forgetting

Natural aging only lowers routine recall/archives by world time. Explicit search/read/date recall can retrieve authorized cold memories; pinning protects routine recall. Unknown event time remains unknown and distinct from recording time.

Explicit forgetting is a previewed operator operation while paused. Authority erases controlled source content and tracked derivatives, records source tombstones, increments the memory epoch of the affected conversations (only the person's own streams for person-private material; every stream for public material), and leaves an external-cleanup job pending. The same trusted host process then stops the QQ, conversation and content writers, invokes the versioned product-only execution purge, restarts execution services and acknowledges only confirmed cleanup. Resuming remains blocked while cleanup is pending. This path is not callable from diary model output.

The purge descriptor (version 2) admits only the conversation executor's session directory; it deletes the transcripts of every earlier memory epoch of the affected streams (each plan entry carries that stream's own new epoch). Unknown layout refuses cleanup; it never guesses other directories. The worker loads purge-execution from its own release (`ops/`, or `deploy/authority/` in a checkout), never from a path pinned in memory-worker.json, so pruning older releases cannot break startup; a legacy `purgeModule` field is ignored. Startup failures log only a stable code such as `MEMORY_CONFIG`. Opaque QQ dispatch request hashes remain as forgotten tombstones, without the forgotten content. No content backup is manufactured by deletion.

QQ platform records, provider-side records, external exports/backups and SSD forensic recovery are not claimed to be erased. Formal runtime data lives on the VM; migration preserves the existing world rather than rebuilding it from laptop history.

## Test coverage / current limits

- Synthetic data and a fake upstream cover UDS Authority → gateway → private diary transport, paused/no-input zero calls, public/private separation, daily limits, source binding and cleanup success/failure; and for consolidation the request shape, answer shaping, commit/invalid/deferred paths and the same transport end to end.
- Consolidation output of the real provider was looked at once on invented chats (`scripts/consolidation-quality-bench.mjs`, development only); it has not run on production dialogue.
- Not covered: live long-term learning or real provider diary output.
