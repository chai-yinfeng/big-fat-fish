# Local file speech (internal Companion capability)

This is a trusted Host adapter, not a model-facing filesystem or cloning tool. No microphone, speaker, CUDA, cloud API, live-audio UI, network download or second inference loop is used. The outer media capability owns artifact IDs, access control, codecs and outgoing-channel receipts; it passes only authorized local paths to this internal runner.

## Interface

```js
import { createLocalSpeechRunner } from './capabilities/speech/runner.js';
const speech = createLocalSpeechRunner({ configFile: '/absolute/operator/speech.json' });
await speech.transcribe({ inputFile: '/allowed-media/input.wav' });
await speech.synthesize({ text: '你好。', outputFile: '/speech-work/new-output.wav', voiceProfile: 'actress' /* omit -> defaultVoice */ });
```

- `transcribe` returns `{text,model,durationMs,derived:true}`. The result is machine transcription, not a verified literal user statement. `durationMs` is audio duration, not processing time. Input must already be **mono PCM16 RIFF WAV**, 8–48kHz (sherpa's native OfflineStream resamples to 16kHz), at most `maxAudioSeconds` (1–600, prepared default 120), 16MiB file ceiling; longer audio fails with `SPEECH_AUDIO_LIMIT` (there is no second ASR engine to fall back to). Audio over 30 s needs the VAD model (see *Long audio*); without it the limit stays 30 s. QQ AMR/SILK/Opus decoding belongs to the media boundary.
- `synthesize` returns `{model,durationMs,sampleRate,mime:'audio/wav'}` only after a valid, nonempty WAV exists. The output path must be new and below `workRoot`. Sending this file and recording a successful QQ receipt are separate operations.
- `language` (default `auto`) is validated but Qwen3-ASR uses its own language identification.
- Error codes: missing config/runtime/weights `SPEECH_NOT_CONFIGURED`; schema-1 config `SPEECH_CONFIG_SCHEMA`; disabled engine `SPEECH_MODEL_DISABLED`; unknown voice id `SPEECH_VOICE_UNKNOWN`; no default voice or a reference failing its checks `SPEECH_REFERENCE_REQUIRED`. `status()` reports `longAudio` (`vadPresent`, `singlePassSeconds`, effective `maxAudioSeconds`, `timeoutMs`, and a `SPEECH_VAD_NOT_INSTALLED` hint when the VAD is missing), component presence, enabled state, a matching operator CPU-benchmark record (`verified:true` only refers to that bounded synthetic benchmark), `defaultVoice` and the voice list (id, engine, usage scope, audition flag).
- Each runner serializes its requests; keep one runner per product process. Each request launches one child that loads only the selected model, then exits. Timeout or a trusted `AbortSignal` kills the whole process group (including the native TTS CLI) and removes partial output (`SPEECH_TIMEOUT` / `SPEECH_CANCELLED`). The signal is never serialized into the JSON job.
- Configuration, executable/module locations, model paths and voice references are trusted operator inputs, never LLM arguments. Stderr and native prompt logs are not returned. Child environment excludes provider credentials. Native TTS receives a private temporary prompt file, not reply text in process arguments.
- `workerFile` is a constructor-only test seam, not an operator JSON field or tool parameter.

## Engines (config schema 2)

| Operation | Key | Engine |
|---|---|---|
| ASR | `models.asr.default` | sherpa Qwen3-ASR-0.6B 2026-03-25 int8 |
| TTS | `models.tts['llama-tts']` | llama.cpp `llama-tts` Qwen3-TTS-12Hz-1.7B Base Q4_K_M + Q8 mmproj |

Sherpa configs fix `provider:'cpu'` and debug off. `numThreads` is 1–16; preparation writes 8, which was fastest on the production Ryzen 8845HS (8C/16T): llama-tts RTF ≈1.1, Qwen3-ASR RTF ≈0.1–0.15. SenseVoiceSmall (RTF ≈0.013, less accurate) was removed because Qwen3-ASR latency is acceptable; it can be re-added later as another `models.asr` entry. The pinned npm release is `sherpa-onnx-node@2.0.1`; npm installs the host's `sherpa-onnx-linux-x64` or `-arm64` native package.

Qwen3-ASR output passes through `toSimplifiedChinese` (`text.js`), currently an identity hook. Stock Qwen3-ASR normally answers in Simplified; one benchmark clip came back Traditional with Chinese numerals, so a conversion may be added later.

Possible future TTS backups (not implemented): CosyVoice 3 (cross-lingual mode) and VoxCPM2 (reference-only mode). Both worked on the production CPU at RTF ≈3–5. Adding one means a new `models.tts[<engine>]` entry plus a worker adapter.

## Long audio (VAD chunking)

The sherpa Qwen3-ASR decoder export has `max_total_len` 512 (prompt + audio KV) and audio costs ~13 tokens/s. Measured on home-agent: 20/25/30 s transcribe completely, 35 s truncates, 40 s and 69 s return only `language`. So one pass is limited to 30 s (`SINGLE_PASS_SECONDS`).

Audio ≤30 s is decoded in one pass exactly as before. Longer audio (when `models.vad` is installed) is resampled to 16 kHz, split by Silero VAD (threshold 0.5, min silence 0.3 s, min speech 0.25 s, max speech 20 s), and the speech regions are grouped in order into chunks of at most 25 s (`chunks.js`, keeping the pauses inside a chunk, 0.2 s padding). A voiced region still longer than 25 s is hard-split into 25 s windows with a 1 s overlap, and text repeated across that overlap is dropped once when joining. Each chunk is a separate Qwen3-ASR stream in the same child process; the joined text is still a derived machine transcript. `timeoutMs` (≤300 s) bounds the whole request, all chunks included.

`maxAudioSeconds` ceiling 600: QQ voice is ≤60 s; for later video audio a 16 kHz PCM16 WAV reaches the 16 MiB ceiling at ~524 s, and 600 s decodes in roughly 2 min (RTF ~0.18 plus load), inside the 300 s timeout cap.

`models.vad` is optional: `{ id: 'silero-vad-v5.1.2', engine: 'sherpa-silero-vad', file }` (`enabled:false` turns it off). Configs prepared before it simply lack it; `install-speech --models vad` adds it and raises the old default `maxAudioSeconds` 30 to 120 (an operator-chosen value is kept). No schema change.

Measured with the product worker on home-agent (8 threads, Silero VAD + Qwen3-ASR int8, TTS-built clips, wall time including child start and model load): 35 s → 165/165 chars, 7.9 s; 40.8 s → 191/191 chars, 9.1 s; 69.3 s → 330/330 chars, 13.5 s; CER 0 against the source sentences.

## Voices

`voiceProfiles` maps a voice id (`[a-z0-9][a-z0-9-]{0,39}`) to `{id,label,engine,referencePath,referenceTranscript,referenceLanguage,useReferenceText,usageScope,auditioned}`; `defaultVoice` is one of those ids or `null`. Voices are registered by the operator through the content operator port / console (see `capabilities/media/OPERATOR.md`), never by the model.

- `engine` names a `models.tts` entry; only `llama-tts` exists.
- `referencePath` must be `workRoot/reference/operator-<uuid>.wav` with a sibling manifest whose origin is `operator-authorized` and whose sha256, voice id and transcript match, plus a consent timestamp. Reference audio is mono PCM16, 3–20s.
- `referenceTranscript` is provenance. `llama-tts` v0.8.0 conditions only on `--tts-speaker-file` (no ICL/transcript input), so `useReferenceText` must be `false` for it. This is also the right choice for cross-lingual voices (e.g. a Japanese reference speaking Chinese): passing the transcript to engines that support it caused accent or prompt leakage in benchmarks. Output language is the engine's `language` (`zh`).
- `usageScope` is a recorded label: `private` = internal use among the user's family and friends (e.g. a real voice actress's clip; private and group chats alike), `public` = may be published (e.g. a purely synthetic voice). It is not enforced now; enforcement belongs to a future public-publishing channel (Bilibili/live), which does not exist yet.

The pinned `llama-tts` v0.8.0 exits 0 even at its frame limit, so the wrapper parses its completion summary and requires **0 < generated frames < maxFrames**; reaching the limit, a missing summary, nonzero exit or timeout is a failure and the partial output is removed. Upstream calls this binary a playground, not production-ready.

## Operator preparation

`deploy/authority/prepare-speech.mjs` (`ops/` in a release) only creates private directories, a schema-2 configuration with no voices and a model provenance manifest. It installs, downloads and runs nothing. An existing schema-2 config is preserved; a schema-1 config or manifest is refused with `SPEECH_CONFIG_SCHEMA` — move both files aside and re-run (no migration; no production speech config existed when schema 2 was introduced). Default locations: runtime `~/.local/opt/companion/speech-node`, models `base/speech-models`, work and references `base/speech-data`, input `base/media-data`.

## Explicit private installer (not run during development)

```sh
"$HOME/.local/opt/companion/bin/node" /absolute/release/ops/install-speech.mjs --plan --models all
# Only after the user explicitly authorizes downloads/install/build. On home-agent:
"$HOME/.local/opt/companion/bin/node" /absolute/release/ops/install-speech.mjs --apply --models all \
  --model-source modelscope --proxy http://127.0.0.1:7890 --hf-endpoint https://hf-mirror.com \
  --archive-dir /absolute/dir/with/sherpa-archive
# Existing install, add only the long-audio VAD (ModelScope is reached directly; --proxy is for the GitHub fallback):
"$HOME/.local/opt/companion/bin/node" /absolute/release/ops/install-speech.mjs --apply --models vad \
  --model-source modelscope --proxy http://127.0.0.1:7890
```

- `--plan` (default) validates the canonical `companion-world-v1` root and its Authority marker and performs no network request or write. `--apply` requires Linux arm64/x64 and the private Node 24.
- `--models asr` installs the private npm runtime (sherpa 2.0.1 + sharp 0.35.5), the Qwen3-ASR archive and the Silero VAD; `all` (default) adds the two Qwen3-TTS GGUFs and builds `llama-tts`; `vad` installs only the VAD file (no npm, no other model) and registers it in `speech.json`/`speech-models.json` if missing — the step for an existing install.
- `--model-source huggingface|modelscope` (default huggingface) chooses where the GGUFs and the VAD come from (the VAD's non-ModelScope source is GitHub). ModelScope `ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF` serves byte-identical files; the fixed sha256 and sizes below are checked either way, and the manifest keeps the canonical Hugging Face source. The sherpa Qwen3-ASR archive has no confirmed ModelScope path (TODO in the manifest) and comes from GitHub releases, which fail from home-agent even via the proxy (`SSL_ERROR_SYSCALL`).
- `--hf-endpoint https://hf-mirror.com` rewrites only huggingface.co URLs (GGUFs when the source is huggingface, and the small upstream model card).
- `--proxy http://host:port` is used for GitHub, npm and git: the installer re-runs itself under `node --use-env-proxy` with `HTTPS_PROXY`, and passes the proxy to npm/git children. ModelScope and hf-mirror are excluded via `NO_PROXY` (they were faster or only worked without the proxy).
- `--archive-dir <absolute dir>`: a sha256-pinned download whose exact filename is present there (regular file) is copied from it instead of fetched; size and sha256 must still match, otherwise `SPEECH_DOWNLOAD_DIGEST`. Fetch the ASR archive on a machine with GitHub access and copy it over.
- ASR archive pin (observed on a direct GitHub download, 2026-11-08; upstream publishes no digest): `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2`, 878,702,423 bytes, SHA256 `393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96`
- Downloads are cached privately; the model card and license are unpinned and recorded as observed. Tar extraction uses Python `tarfile` with `filter='data'` plus path/type/link preflight. Existing model directories are never overwritten; failed staging directories are left for diagnosis.
- `all` uses [official CMake 4.4.5](https://github.com/Kitware/CMake/releases/tag/v4.4.5) for the host architecture (sha256 checked against the publisher list), clones only the pinned llama.cpp `v0.8.0` (commit `8642541b255bfb5dc39cd351a178be09013a55d6`), verifies a clean tree, and builds only `llama-tts` CPU-only (`-j2`). Runtime fixes `--device none`, `-ngl 0`, `--no-mmproj-offload`.
- VAD pin (observed 2026-11-08; upstream publishes no digest): Silero VAD v5.1.2 `silero_vad.onnx`, 2,327,524 bytes, SHA256 `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`, MIT. Source `raw.githubusercontent.com/snakers4/silero-vad/6478567951ae5c9979ad7b234185b5515f4be7a1/src/silero_vad/data/silero_vad.onnx`; byte-identical ModelScope copy `pengzhendong/silero-vad@370539c71ec0ac703627938064cf31c1852186d7` `v5/silero_vad.onnx` (reachable from home-agent directly). Installed to `speech-models/silero-vad-v5.1.2/` with a `SOURCE.json`; `--archive-dir` with a file named `silero_vad.onnx` also works.
- GGUF snapshot `ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF@ca27d74bc954b73dadab5b71ca265d87fc861a7c`:
  - `Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf`: 1,035,965,280 bytes; SHA256 `8d18c94acb2addd042f97da63c98be144eafa76d0d9495177eab65130cf85129`
  - `mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf`: 446,422,912 bytes; SHA256 `6fd65188839bcd6ecc91b277ad471e22a0edfada4699a0fe82f1165c18cfcce2`
- Disk reserves (estimates): 3–4GiB `asr`, 8–12GiB `all`. Metadata records observed digests, npm lock hash and `inferenceVerified:false`; failures print fixed codes only.

After installation, register a voice in the console, audition it, and optionally run `ops/benchmark-speech.mjs --run --kind tts|asr [--voice <id>]`. The benchmark synthesizes a fixed public sentence with a registered voice and transcribes it; it reads no human recording besides the registered reference and never writes into persona memory.

## Test coverage / current limits

- `runner.test.js` uses a fake child: path boundaries/symlink escape, serialized jobs, the ASR length cap with/without the VAD, voice resolution, schema refusal, reference manifest checks, sanitized failure/recovery. The installer is checked via pure helpers (`cmakeFor`, `hfUrl`, `ggufUrl`, `proxyEnv`, `localArchive`) and a prepared-manifest plan fixture.
- `chunks.test.js` covers chunk planning (grouping, hard split with overlap) and joining.
- Not covered by tests: real model loading, intelligibility, latency, `--apply`, and the ModelScope/proxy download path on the host.

## Source evidence

- [Sherpa Node-addon installation](https://k2-fsa.github.io/sherpa/onnx/javascript-api/install.html)
- [Qwen3-ASR class example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_asr_non_streaming_qwen3_asr.js)
- [Native offline stream resampling](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-stream.cc)
- [Qwen3-ASR int8 files](https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/pretrained.html)
- [llama.cpp pinned TTS source and completion semantics](https://github.com/ggml-org/llama.cpp/blob/v0.8.0/tools/tts/tts.cpp)
- [GGUF snapshot file hashes](https://huggingface.co/api/models/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF/tree/ca27d74bc954b73dadab5b71ca265d87fc861a7c?recursive=true)

Runtime Apache/MIT licenses are not blanket licenses for every speech weight or voice. Retain each pinned artifact's own notices. Cloning a real person's voice needs that person's consent regardless of model license.
