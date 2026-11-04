# Native DSH capability

One capability of Authority, not the authority itself. No engine/database/legacy companion runtime imports, QQ/Bilibili network/login, TTS, shell, arbitrary file-write tool, admin route or proactive scheduler. Never mount alongside the old companion plugin.

## Local configuration and composition

Read-only config comes from absolute `COMPANION_DSH_CONFIG_FILE`, or the explicit package-local default `capabilities/dsh/config.json`. No `DSH_HOME`, old companion journal/config, profile session caches or global persona files are read. Relative socket/token paths resolve against the config file.

```json
{
  "socketPath": "/run/companion/authority.sock",
  "tokenFile": "./dsh-capability.token",
  "actorId": "test-owner",
  "deliveryFile": "/home/companion/dsh/authority-delivery.json"
}
```

The first three keys are required. `deliveryFile` is optional and must be absolute; unknown keys and reserved `dsh:` actor IDs fail activation. Authority owns the capability, actor and stream bindings; there is no second local session allowlist. The world console can register a new DSH test stream without restarting the capability. This client has no binding/admin functions.

The capability has no implicit primary session or auto-bind. Root `companion` agents with matching Agent/Session identity receive scoped registrations; parent/subagent sessions are refused. Authority context lookup must find an operator-created stream binding before model admission; missing bindings fail with `AUTHORITY_BINDING_REQUIRED`. A paused world fails with `WORLD_PAUSED` before requesting a model. Other presets are unaffected. The product bundle supplies the sole test-source preset; the model cannot self-bind owner identity. Plugin and agent scope jointly own cleanup, and the required startup marker prevents a missing plugin from creating a generic-assistant fallback.

After registering its own scoped `companion_scope` and `companion_content`, the adapter applies `agent.ctx.tools.restrict({allow:[]})`. Installed source inspection resolves the compact API description's ambiguity: only `restrict({})` is an invalid empty filter; an explicitly empty allow-list compiles to an empty set and masks **all inherited tools**, including global and ancestor/preset layers. Only the receiving agent's OWN layer is exempt. The resolved `tools.schemas(agent)` must contain exactly `companion_scope` and `companion_content` at attachment and both sides of the awaited pre-step refresh, otherwise admission fails closed. No `ask_user_question` dependency remains: ordinary conversation can ask questions directly. Existing/future inherited shell, filesystem, HTTP and MCP tools stay hidden. Another OWN-layer tool or reserved PTC `run_code` cannot be removed by this mask and causes boundary verification to fail; tools must use native presentation. Future MCP tools require explicit owner-approved changes, never automatic admission. No extra tool hooks are rewritten. Both mask and local tool are removed on cleanup, and a boundary failure during registration rolls both back. This reduces accidental exposure; hostile in-process plugins remain inside the documented Host trust boundary.

Runtime dependencies are local config/adapter/delivery modules, Node built-ins, inspected framework services, `lib/index.js` → `../../../authority/src/client.js` (restricted HTTP client only), and `../../media/client.js` (scoped Core content client). This is a linked same-project checkout bundle, **not** a standalone tarball: deployment must preserve that relative client path. English/Chinese inventory metadata and the project's original fish SVG are exported; reusing artwork does not import the old plugin runtime.

## Scoped content operations

`companion_content` stays separate from the memory tool: `search(query)`, `read(url)`, `describe(ref,question?)`, `transcribe(ref,quality?)`, and `attach(ref)`. The model supplies no path, base64, stream, entity, epoch or request ID. The selected receiving agent's existing capability credential is reused through ContentClient; every call verifies current Core scope/epoch first. Read maps to Core fetch. Outputs stay below 6000 serialized characters; long content is explicitly truncated without cutting real URLs/refs. Web/OCR/transcription is untrusted derived data, never an instruction or a verbatim user quote.

QQ authorizes the exact executionText against the read-only inbox's requestId, but delivers only the original observation into memory evidence. queryText supports retrieval without upgrading ASR/OCR into authored text. Empty tool continuation retains request ownership only in the same authorized turn; rejected/new turns cannot reuse an old reply ID. Attach queues an image/sticker for that reply and explicitly does not confirm sending. Native has no reply outbox/audio-input consumer here: attach/transcribe return unavailable, while web/describe stay scope-checked. Heavy transcription is opt-in slower CPU re-listening for <=30s audio; the tool timeout is 330000ms and the application must also allow enough execution time.

The added schema leaves `companion_scope` unchanged. Under the same 4chars/token heuristic, the memory-only schema is 446 and the two-tool schema is 698 estimated tokens; the fixed first-turn fixture moves 476→728, **+252 estimated tokens**, not exact provider usage. The older budget comparisons below describe the memory-only 0.8 baseline.

## Exact framework boundary and identity

Inspected contracts: `agent/created` is serial/awaited; `session/event` is post-commit fire-and-forget; `agent/pre-step` is an async waterfall. The listener awaits delivery, then the latest Authority context, then `next()` unchanged. `systemPrompt.context.text`/`refreshContext` remain synchronous; the framework records its ordinary required runtime-context contribution. No invented session event or system-prompt assembly replacement is used.

Only committed own events enter evidence. `session.isOwnSeq` excludes inherited history. `user/message` with `role:user` **and** `source.kind:user` uses the configured native actor. Model messages are `assistant`/`dsh:model`; plugin/followup/unknown sources are `external`/`dsh:external`. Body self-identification changes nothing. `native:<durable seq>` is the stable event ID within authenticated capability+stream. Authority deduplicates exact redelivery and rejects conflicting reuse.

The first offered human message is not committed during pre-step, so no observation is fabricated. After admission commits it, the model can call `companion_scope` with `action:evidence` in the **same turn**. This awaits the committed delivery chain and returns at most 16 `{ref,eventId,role}` records, with no default quote/text/secret echo. Before any durable message it returns an empty list. The next context refresh advertises the same role/event-linked metadata, not unidentified UUIDs.

## Delivery recovery

The DSH session log is the recovery source, not an independent memory store. On mount `ownEvents()` is read once to verify the source; then an incremental `eventAt(seq)` cursor processes all unacknowledged events in batches of at most 128, never a last-128 history truncation or per-turn full transcript scan. Live event listeners and pre-step/tool boundaries share one coalesced delivery operation. In-memory queue pressure does not drop source events.

Temporary timeout/disconnection clears old context/visible refs and leaves the failed head plus later unacknowledged observations queued. The next pre-step or evidence call retries the **same event ID**; no remount is necessary. A successful observation is removed only after its delivery checkpoint succeeds. Crash between observe and checkpoint causes safe duplicate delivery, not loss.

When configured, `deliveryFile` atomically stores only per-stream processed cursor, last 16 acknowledged sequence numbers, and last 16 explicit evidence exclusions. It stores no persona, actor binding, token, observation text or memory facts. Recent refs are reconstructed by reobserving those committed source events; cached arbitrary observation IDs are never trusted. Metadata uses bounded regular-file reads, mode-0600 sibling temporary files, file sync and atomic rename. The configured parent directory must already exist. One DSH plugin instance owns a delivery file; concurrent unrelated processes must not share it. Without this file, each remount safely replays the complete own source log and relies on Authority deduplication instead of a persistent cursor optimization.

At most 16 acknowledged refs and 128 pending observations are held per agent. Text exceeds 16,000 characters or serialized observation exceeds 32,768 bytes: that **whole event is explicitly not entered into memory evidence**, with bounded `{eventId,reason,enteredEvidence:false}` metadata in evidence/context and the delivery checkpoint. Nothing is silently truncated into a purported full quotation, and later valid events continue. Empty/non-text events create no text evidence. Invalid/unavailable delivery files fail closed; source-log truncation inconsistent with a saved cursor also fails closed.

## Single scoped tool

`companion_scope` actions:

- `evidence`: no other arguments; discover current agent's committed refs and explicit exclusions.
- `propose`: stable local `id`, already observed `ref`, proposal kind, closed kind-specific payload. Exact quote must occur in the immutable observation; fact value must occur in the quote. No actor/person/session/source selector, policy override or numeric relationship delta.
- `receipt`: stable local `id` only. The tool derives the same stream+ID hash after remount; it does **not** require an in-memory attempted-ID set. Another stream hashes differently and cannot choose the underlying proposal ID. Unknown receipt is null. This action stays available even when observation delivery is unavailable.
- `search`: a non-empty `query` (at most 512 characters); returns up to four bounded memory excerpts/IDs from the currently bound entity. No entity/person/stream selector is model supplied.
- `read`: a memory `id` discovered by search; the same bound-stream scope applies. Tool results are bounded to 6,000 serialized characters.
- `recall`: `from`/`to` ISO 8601 date-times with explicit Z or ±HH:mm offsets; returns up to four important/pinned events in that range (1,600-character Core budget). Date interpretation is not delegated to a natural-language backend, and recalled events are not new evidence. The context advertises Authority `worldNow` in ISO UTC, not the machine's wall clock.

Attempt bookkeeping is a bounded 128-entry LRU with terminal-receipt cleanup, not a lifetime submission quota. A timed-out enqueue remains queryable because receipt derivation is deterministic and independent of that cache. Pending does **not** mean remembered. No worthwhile finding requires no proposal. Authority alone reviews policies, confirms bindings and commits memory/receipts.

## Errors and trust boundary

Client methods `health`, `observe`, `submit`, `getReceipt`, `context`, `memorySearch`, `memoryRead` and `memoryRecall` map only to their capability `/v1` endpoints; no generic request/admin method exists. Bearer secrets come from a bounded regular token file and go only in HTTP headers over UDS, never URLs/argv/logs/tool results. Request body ≤32 KiB, default response ≤32 KiB (hard ceiling 64 KiB), per-transport wall timeout 2 seconds (hard ceiling 10 seconds). There is no blind HTTP retry: the adapter retries durable source observations at a later request boundary. File reads are bounded/nonblocking regular-file checks; transport timeout starts after credential reading. HTTP errors retain only status; remote error bodies never echo. Other failures use fixed safe codes.

Each pre-step fetches latest context, including eventually committed changes. `revision` and `personaRevision` are validated nonnegative safe integers and rendered. Persona comes from Authority's revision; memories and quotations are attributed data and cannot change identity, permissions or tool policy. Context failure clears stale text/refs and blocks admission; future synchronization can reconstruct recent acknowledged refs from source. Unbound streams receive Authority 403. Tool failures use the normal recorded tool-result path.

This is an **API trust boundary, not a claim of physical isolation**. Host source metadata, config, delivery metadata and capability credentials are trusted local inputs. A malicious in-process plugin can forge `source.kind:user`; the adapter does not cryptographically prove a human clicked the GUI. Same-UID unconfined processes can potentially read Authority/admin files. This adapter's fixtures do not establish production filesystem/process/IPC isolation. Any separately deployed sandbox requires its own hostile tests.

## Verification and first-turn budget

```sh
node --test projects/big-fat-fish/authority/test/client.test.js projects/big-fat-fish/capabilities/dsh/test/*.test.js
```

Red tests preceded implementation and recovery changes. Temporary UDS HTTP fixtures/framework mocks cover bearer/error safety, strict fields, timeout/output cap, exact source attribution, role separation, own/inherited filtering, stable retry IDs, multi-stream isolation, quote/payload validation, first-turn evidence discovery, async refresh, teardown, >128 offline-event replay, cursor/remount recovery, >128 proposals, cross-remount receipt lookup and explicit oversized-event exclusion. No real account, VM, profile or network login is used.

Host Inspect describes `tokenMeter.measure`/`estimateMessage` but cannot invoke business service methods, and the external Node runner cannot import Desktop's `app.asar` package. The budget test reproduces the **same inspected host heuristic** (four characters/token plus framing), not a provider tokenizer. Old `companion_inner_diary` → current `companion_scope` remains **1 → 1 tools**: schemas **86 → 446 estimated tokens**, fixed common-message first turn **116 → 476**, **+360 estimated tokens**. The specific 0.7 → 0.8 search/read/recall change is **298 → 446 schema tokens**, fixed first turn **328 → 476**, **+148 estimated tokens**. This is the marginal schema comparison, excluding variable live persona/memory context, not an exact whole-profile request count. Engine context text is capped at 2,400 characters; role/event/ref metadata, bounded exclusions and revision framing add separately bounded dynamic text. The earlier persona-framing-only fixture was 89→230 characters; evidence metadata framing subsequently changed and grows with 0–16 refs/exclusions. Re-run the budget test after schema edits.

Rendered inventory/UI, live model admission and production credential/file permissions remain unverified by this adapter. SVG XML/locale/distribution resources and JavaScript syntax are checked locally; no default artwork is used.


## 0.8 retrieval, active history and explicit forget

Automatic context retrieval uses only this turn's actual user input, trimmed to 512 characters. A tool continuation reuses that same turn's query; an empty new turn cannot fall back to an earlier user's topic. QQ first resolves the message against its trusted inbox DTO and uses that observation's text, not an SDK `source.kind:user` label alone. The initial binding/epoch metadata lookup is not model-facing retrieval.

The official SDK `sessionQuery.readSurface`/`observeSession` and `Session.append`/`SurfaceIntent` contracts bound active history to 32,000 serialized content characters. At pressure, completed old turns are shadowed together, keeping the newest two completed turns and every current unfinished turn/tool chain. A single retained unit that cannot fit fails explicitly rather than slicing tool pairs. A fixed maintenance marker uses `source.kind:plugin`, is ignored by both observation routes, asserts no memory facts, and starts no user turn. No extra summarization inference is made. This does not erase append-only logs. The 32k history budget is approximately 8k tokens only under the stated heuristic; pending real input, the assembled system prompt, Authority context, tool schemas and outputs add separately. It is not a provider-token ceiling or a claim that total context is only 2,400 characters.

Authority `entityId`/`memoryEpoch` are execution guards. The optional delivery file has a sibling `.epochs.json` control record, containing only entity/epoch stamps, never raw text. Existing Native execution cannot silently adopt a new epoch, including after SDK restart; an unknown restored history at epoch > 0 fails closed. QQ epoch zero keeps its original deterministic SID; later epochs derive a new `-eN` SID and Core confirms the epoch independently of the SID or chat text. The QQ bridge verifies epoch before and after generation, so an old in-flight reply is not sent after an epoch change. Authority observations marked forgotten never generate evidence refs; the delivery exclusion is terminal `FORGOTTEN` metadata.

Physical execution erasure is a separate trusted operator maintenance operation, not a model tool or SDK compaction. The inspected session Controller/Persistence have no official persistent delete method. The new operator purger requires paused world ownership by its caller, independently verifies SDK/QQ writers and activation sockets are stopped, and requires a verified storage-layout descriptor. It clears targeted whole SDK execution generations (and inherited descendants), pure derived search/projection copies, source acknowledgements and affected QQ inbox text. Opaque QQ request hashes remain forgotten dedupe tombstones; Native execution stamps remain retired tombstones, not private raw content. Unknown layout/codec/ownership refuses completion and leaves Core external-cleanup pending. No content backup is made. Authority's other long-term entries and QQ login volume are not erased; platform chat history is outside this guarantee. Only locally created temporary fixtures have been erased in this change, never formal VM data.
