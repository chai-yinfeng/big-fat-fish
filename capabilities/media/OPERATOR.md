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

- `status`: safe projection only. No pause required and no configuration write. `speech.configurationRevision` is SHA256 of the current configuration bytes; absent `defaultTtsQuality` is displayed as `heavy` without silently saving. Models expose only model ID, component presence, enabled and CPU-benchmark verification flags. Image generation is explicitly not configured.
- `configure`: requires `expectedRevision`, `defaultTtsQuality`, `numThreads` (1 or 2) and `maxTextChars` (1–120). Unknown fields/paths/executables are rejected. Heavy requires components, enabled state and existing CPU admission. The host does not change model registries or Authority data.
- `reference`: requires `expectedRevision`, `authorized:true`, `audioBase64` and exact `transcript` (nonempty, ≤1000 Unicode characters). Audio must be canonical Base64 of mono PCM16 RIFF WAV, 8–48kHz, 3–20 seconds, ≤2MiB. The uploaded audio and its manifest are private; responses never contain the reference waveform, transcript or path. A current operator reference must be explicitly removed before another upload (409), avoiding untracked old recordings.
- `test`: requires `quality:'heavy'`. Uses one fixed public sentence and the registered reference; returns public test audio only (`audioBase64`, WAV MIME, duration, model). It never sends QQ media, observes a conversation or resumes the world. Failure/cancellation removes its exact temporary output. A very small configured text cap may prevent this fixed sentence from synthesizing; this does not bypass the configured cap.
- `removeReference`: requires `expectedRevision`, `confirmed:true`. While no operator test/mutation is active, validates the current operator-owned audio/manifest absolute paths and atomically restores the preserved Kokoro synthetic pointer **with a private pending upload ID**. It deletes only that upload and manifest, then CAS-clears pending. An unlink/last-save failure leaves `voice.cleanupPending:true`, returns failure rather than claiming removal, and permits explicit retry even though the active origin is now Kokoro. Already-missing upload files count as cleaned on retry. Uploading another reference is blocked until pending is cleared. No path or upload ID is projected to the client. It does not delete synthetic audio, model weights, other recordings, datasets or directories, nor switch default TTS quality back to light. Constructor-only `unlinkReference` is a narrow failure-injection seam, not an input or config field.

All actions other than status require the world to be paused. `worldRevision` is optional: when supplied (Core's operator proxy supplies the revision it observed), the world must stay at exactly that revision, otherwise 409. Settings changes perform configuration CAS (`expectedRevision`) and recheck pause before replacement. Operator mutations/tests reject concurrent work with 409; status remains readable. Server cancellation propagates when the client disconnects, the pause is lifted, or a supplied world revision changes. The shared speech runner preserves a single CPU queue inside the process.

Request JSON is limited to3MiB for this route and results to8MiB. Errors use fixed sanitized codes and status400/409/413/503. No provider key, arbitrary path, private original recording or vendor error string is returned.

## Actual native conditioning capability

Checked the installed VM's `llama-tts --help` without loading weights and the [pinned v0.8.0 TTS documentation](https://github.com/ggml-org/llama.cpp/blob/8642541b255bfb5dc39cd351a178be09013a55d6/tools/tts/README.md).

This build supports Qwen3-TTS `--tts-speaker-file` and language selection. It has **no reference-transcript/ICL CLI argument**. An operator recording is therefore used for **speaker-file conditioning only**. Its transcript is stored privately as provenance and for possible future adapters; it is not secretly passed as target speech or claimed to participate in ICL. Both voice status and public test results report:

```json
{"referenceConditioning":"speaker-file-only","transcriptUsedForSynthesis":false}
```

The speech worker validates registered reference origin, hash and path. Kokoro synthetic manifests keep the original model/text/speaker checks; operator-authorized manifests require a fixed reference-directory UUID path, consent timestamp, bounded transcript and supported WAV. Models cannot choose another reference path or voice ID.

Three direct tests cover safe read/CAS/pause/field closure, authorized-reference validation/deletion preserving synthetic audio, and public test output/cancellation/cleanup/exclusion of concurrent mutation. Real reference-audio quality and synthesis are not claimed from these injected-runner tests.
