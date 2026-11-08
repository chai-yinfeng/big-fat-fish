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

## Privacy and publication

Private reflection is not returned to external conversation capabilities. The operator console reads it only after an explicit click. Public drafts are generated in a separate request from material the operator has explicitly authorized for public use. A private diary is never supplied to a model for automatic “de-identification and publication”. Publishing a draft is a separate human operation and does not send a QQ message.

## Explicit forgetting

Natural aging only lowers routine recall/archives by world time. Explicit search/read/date recall can retrieve authorized cold memories; pinning protects routine recall. Unknown event time remains unknown and distinct from recording time.

Explicit forgetting is a previewed operator operation while paused. Authority erases controlled source content and tracked derivatives, records source tombstones, increments the entity memory epoch, and leaves an external-cleanup job pending. The same trusted host process then stops the QQ, conversation and content writers, invokes the versioned product-only execution purge, restarts execution services and acknowledges only confirmed cleanup. Resuming remains blocked while cleanup is pending. This path is not callable from diary model output.

The purge descriptor (version 2) admits only the conversation executor's session directory; it deletes the transcripts of every earlier memory epoch of the affected streams. Unknown layout refuses cleanup; it never guesses other directories. The worker loads purge-execution from its own release (`ops/`, or `deploy/authority/` in a checkout), never from a path pinned in memory-worker.json, so pruning older releases cannot break startup; a legacy `purgeModule` field is ignored. Startup failures log only a stable code such as `MEMORY_CONFIG`. Opaque QQ dispatch request hashes remain as forgotten tombstones, without the forgotten content. No content backup is manufactured by deletion.

QQ platform records, provider-side records, external exports/backups and SSD forensic recovery are not claimed to be erased. Formal runtime data lives on the VM; migration preserves the existing world rather than rebuilding it from laptop history.

## Test coverage / current limits

- Synthetic data and a fake upstream cover UDS Authority → gateway → private diary transport, paused/no-input zero calls, public/private separation, daily limits, source binding and cleanup success/failure.
- Not covered: live long-term learning or real provider diary output.
