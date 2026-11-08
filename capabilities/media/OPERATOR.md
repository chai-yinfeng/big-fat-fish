# Private content operator port

This is a trusted human-control port, not a model tool or a second Authority. The content UDS accepts authenticated POST `/operator` using its existing control token. Core owns the user-facing authentication/proxy. `/content` retains its separate capability scope protocol and running-world requirement.

## Factory and actions

```js
const operator = createContentOperator({
  speechConfigFile, worldStatus,
  // Optional trusted injection; main shares MediaService's existing runner.
  speechFactory: () => speech,
});
await operator.call({ action: 'status' }, { signal });
```

- `status`: safe projection only. No pause required and no configuration write. `speech.configurationRevision` is SHA256 of the current configuration bytes. Models (`asr:default`, `asr:fast`, `tts:<engine>`) expose only model ID, component presence, enabled and CPU-benchmark verification flags. `voices` lists each registered voice (id, label, engine, reference language, usage scope, `useReferenceText`, audition flag, whether its reference passes checks), `defaultVoice` and `cleanupPending`; never a path, transcript or upload ID. Image generation is explicitly not configured.
- `configure`: requires `expectedRevision`, `numThreads` (1–16) and `maxTextChars` (1–120). Unknown fields/paths/executables are rejected. The host does not change model registries or Authority data.
- `reference`: registers a new voice. Requires `expectedRevision`, `voiceId` (`[a-z0-9][a-z0-9-]{0,39}`, not already registered), `label` (≤64), `language` (2–3 lowercase letters, the reference's language), `usageScope` (`private` | `public`), `authorized:true`, `audioBase64` and `transcript` (nonempty, ≤1000 Unicode characters, provenance only). Audio must be canonical Base64 of mono PCM16 RIFF WAV, 8–48kHz, 3–20 seconds, ≤2MiB. It is stored as `workRoot/reference/operator-<uuid>.wav` plus a manifest (sha256, voice id, transcript, consent time). The voice uses the `llama-tts` engine with `useReferenceText:false`. The first voice becomes `defaultVoice`. Blocked while a cleanup is pending.
- `setDefaultVoice`: requires `expectedRevision`, `voiceId` of a registered voice.
- `test`: requires `voiceId`. Uses one fixed public sentence and that voice's registered reference; returns public test audio only (`audioBase64`, WAV MIME, duration, model, voice id). It never sends QQ media, observes a conversation or resumes the world. Failure/cancellation removes its exact temporary output. A very small configured text cap may prevent this fixed sentence from synthesizing; this does not bypass the configured cap.
- `removeReference`: requires `expectedRevision`, `voiceId`, `confirmed:true`. While no operator test/mutation is active, validates that voice's operator-owned audio/manifest absolute paths, removes the voice from the config (clearing `defaultVoice` if it was the default) and records a **private pending upload ID** in the same write. It then deletes only that upload and manifest and CAS-clears pending. An unlink/last-save failure leaves `voices.cleanupPending:true`, returns failure rather than claiming removal, and permits explicit retry (without `voiceId`). Already-missing upload files count as cleaned on retry. Registering another voice is blocked until pending is cleared. It does not delete model weights, other recordings, datasets or directories. Constructor-only `unlinkReference` is a narrow failure-injection seam, not an input or config field.

All actions other than status require the world to be paused. `worldRevision` is optional: when supplied (Core's operator proxy supplies the revision it observed), the world must stay at exactly that revision, otherwise 409. Settings changes perform configuration CAS (`expectedRevision`) and recheck pause before replacement. Operator mutations/tests reject concurrent work with 409; status remains readable. Server cancellation propagates when the client disconnects, the pause is lifted, or a supplied world revision changes. The shared speech runner preserves a single CPU queue inside the process.

Request JSON is limited to3MiB for this route and results to8MiB. Errors use fixed sanitized codes and status400/409/413/503. No provider key, arbitrary path, private original recording or vendor error string is returned.

## Actual native conditioning capability

Checked the installed VM's `llama-tts --help` without loading weights and the [pinned v0.8.0 TTS documentation](https://github.com/ggml-org/llama.cpp/blob/8642541b255bfb5dc39cd351a178be09013a55d6/tools/tts/README.md).

This build supports Qwen3-TTS `--tts-speaker-file` and language selection. It has **no reference-transcript/ICL CLI argument**. An operator recording is therefore used for **speaker-file conditioning only**. Its transcript is stored privately as provenance and for possible future adapters; it is not secretly passed as target speech or claimed to participate in ICL. Both voice status and public test results report:

```json
{"referenceConditioning":"speaker-file-only","transcriptUsedForSynthesis":false}
```

The speech runner and worker validate each voice's reference: only `operator-authorized` manifests are accepted, with a fixed reference-directory UUID path, matching sha256, voice id and transcript, consent timestamp and supported WAV. Synthesis requests can name only a registered voice id (unknown ids fail with `SPEECH_VOICE_UNKNOWN`). `usageScope` (`private` = family/friends internal use, `public` = publishable) is recorded but not enforced; enforcement belongs to a future public-publishing channel. Models cannot choose a reference path.

## Test coverage / current limits

- Three direct tests (injected runner): read/CAS/pause/field closure, voice registration/listing/default/removal with pending cleanup, audition output/cancellation/cleanup and exclusion of concurrent mutation.
- Real reference-audio quality and synthesis are not covered.
