# Local file speech (internal Companion capability)

This is a trusted Host adapter, not a model-facing filesystem or cloning tool. No microphone, speaker, CUDA, cloud API, live-audio UI, network download or second inference loop is used. The outer media capability owns artifact IDs, access control, codecs and outgoing-channel receipts; it passes only authorized local paths to this internal runner.

## Interface

```js
import { createLocalSpeechRunner } from './capabilities/speech/runner.js';
const speech = createLocalSpeechRunner({ configFile: '/absolute/operator/speech.json' });
await speech.transcribe({ inputFile: '/allowed-media/input.wav', quality: 'default' /* or 'fast' */ });
await speech.synthesize({ text: '你好。', outputFile: '/speech-work/new-output.wav', voiceProfile: 'actress' /* omit -> defaultVoice */ });
```

- `transcribe` returns `{text,model,durationMs,derived:true}`. The result is machine transcription, not a verified literal user statement. `durationMs` is audio duration, not processing time. Input must already be **mono PCM16 RIFF WAV**, 8–48kHz (sherpa's native OfflineStream resamples to 16kHz), at most `maxAudioSeconds` (≤30) for `default` and `maxFastAudioSeconds` (≤120) for `fast`, 16MiB file ceiling. QQ AMR/SILK/Opus decoding belongs to the media boundary. The media service picks `fast` up front for audio longer than the default cap; there is no silent fallback after a failure.
- `synthesize` returns `{model,durationMs,sampleRate,mime:'audio/wav'}` only after a valid, nonempty WAV exists. The output path must be new and below `workRoot`. Sending this file and recording a successful QQ receipt are separate operations.
- `language` defaults to `auto`; SenseVoice accepts the supported language hint. Qwen3-ASR uses its own language identification.
- Error codes: missing config/runtime/weights `SPEECH_NOT_CONFIGURED`; schema-1 config `SPEECH_CONFIG_SCHEMA`; disabled engine `SPEECH_MODEL_DISABLED`; unknown voice id `SPEECH_VOICE_UNKNOWN`; no default voice or a reference failing its checks `SPEECH_REFERENCE_REQUIRED`. `status()` reports component presence, enabled state, a matching operator CPU-benchmark record (`verified:true` only refers to that bounded synthetic benchmark), `defaultVoice` and the voice list (id, engine, usage scope, audition flag).
- Each runner serializes its requests; keep one runner per product process. Each request launches one child that loads only the selected model, then exits. Timeout or a trusted `AbortSignal` kills the whole process group (including the native TTS CLI) and removes partial output (`SPEECH_TIMEOUT` / `SPEECH_CANCELLED`). The signal is never serialized into the JSON job.
- Configuration, executable/module locations, model paths and voice references are trusted operator inputs, never LLM arguments. Stderr and native prompt logs are not returned. Child environment excludes provider credentials. Native TTS receives a private temporary prompt file, not reply text in process arguments.
- `workerFile` is a constructor-only test seam, not an operator JSON field or tool parameter.

## Engines (config schema 2)

| Operation | Key | Engine |
|---|---|---|
| ASR | `models.asr.default` | sherpa Qwen3-ASR-0.6B 2026-03-25 int8 |
| ASR | `models.asr.fast` | sherpa SenseVoiceSmall 2024-07-17 int8 (lower latency, less accurate) |
| TTS | `models.tts['llama-tts']` | llama.cpp `llama-tts` Qwen3-TTS-12Hz-1.7B Base Q4_K_M + Q8 mmproj |

Sherpa configs fix `provider:'cpu'` and debug off. `numThreads` is 1–16; preparation writes 8, which was fastest on the production Ryzen 8845HS (8C/16T): llama-tts RTF ≈1.1, Qwen3-ASR RTF ≈0.1–0.15, SenseVoice RTF ≈0.013. The pinned npm release is `sherpa-onnx-node@2.0.1`; npm installs the host's `sherpa-onnx-linux-x64` or `-arm64` native package.

Qwen3-ASR output passes through `toSimplifiedChinese` (`text.js`), currently an identity hook. Stock Qwen3-ASR normally answers in Simplified; one benchmark clip came back Traditional with Chinese numerals, so a conversion may be added later.

Possible future TTS backups (not implemented): CosyVoice 3 (cross-lingual mode) and VoxCPM2 (reference-only mode). Both worked on the production CPU at RTF ≈3–5. Adding one means a new `models.tts[<engine>]` entry plus a worker adapter.

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
  --archive-dir /absolute/dir/with/sherpa-archives
```

- `--plan` (default) validates the canonical `companion-world-v1` root and its Authority marker and performs no network request or write. `--apply` requires Linux arm64/x64 and the private Node 24.
- `--models asr` installs the private npm runtime (sherpa 2.0.1 + sharp 0.35.5) and both ASR archives; `all` (default) adds the two Qwen3-TTS GGUFs and builds `llama-tts`.
- `--model-source huggingface|modelscope` (default huggingface) chooses where the GGUFs come from. ModelScope `ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF` serves byte-identical files; the fixed sha256 and sizes below are checked either way, and the manifest keeps the canonical Hugging Face source. The sherpa ASR archives have no confirmed ModelScope path (TODO in the manifest) and come from GitHub releases, which fail from home-agent even via the proxy (`SSL_ERROR_SYSCALL`).
- `--hf-endpoint https://hf-mirror.com` rewrites only huggingface.co URLs (GGUFs when the source is huggingface, and the small upstream model card).
- `--proxy http://host:port` is used for GitHub, npm and git: the installer re-runs itself under `node --use-env-proxy` with `HTTPS_PROXY`, and passes the proxy to npm/git children. ModelScope and hf-mirror are excluded via `NO_PROXY` (they were faster or only worked without the proxy).
- `--archive-dir <absolute dir>`: a sha256-pinned download whose exact filename is present there (regular file) is copied from it instead of fetched; size and sha256 must still match, otherwise `SPEECH_DOWNLOAD_DIGEST`. Fetch the two ASR archives on a machine with GitHub access and copy them over.
- ASR archive pins (observed on a direct GitHub download, 2026-11-08; upstream publishes no digest):
  - `sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2`: 878,702,423 bytes; SHA256 `393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96`
  - `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`: 163,002,883 bytes; SHA256 `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e`
- Downloads are cached privately; the model card and license are unpinned and recorded as observed. Tar extraction uses Python `tarfile` with `filter='data'` plus path/type/link preflight. Existing model directories are never overwritten; failed staging directories are left for diagnosis.
- `all` uses [official CMake 4.4.5](https://github.com/Kitware/CMake/releases/tag/v4.4.5) for the host architecture (sha256 checked against the publisher list), clones only the pinned llama.cpp `v0.8.0` (commit `8642541b255bfb5dc39cd351a178be09013a55d6`), verifies a clean tree, and builds only `llama-tts` CPU-only (`-j2`). Runtime fixes `--device none`, `-ngl 0`, `--no-mmproj-offload`.
- GGUF snapshot `ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF@ca27d74bc954b73dadab5b71ca265d87fc861a7c`:
  - `Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf`: 1,035,965,280 bytes; SHA256 `8d18c94acb2addd042f97da63c98be144eafa76d0d9495177eab65130cf85129`
  - `mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf`: 446,422,912 bytes; SHA256 `6fd65188839bcd6ecc91b277ad471e22a0edfada4699a0fe82f1165c18cfcce2`
- Disk reserves (estimates): 3–4GiB `asr`, 8–12GiB `all`. Metadata records observed digests, npm lock hash and `inferenceVerified:false`; failures print fixed codes only.

After installation, register a voice in the console, audition it, and optionally run `ops/benchmark-speech.mjs --run --kind tts|asr [--quality default|fast] [--voice <id>]`. The benchmark synthesizes a fixed public sentence with a registered voice and transcribes it; it reads no human recording besides the registered reference and never writes into persona memory.

## Test coverage / current limits

- `runner.test.js` uses a fake child: path boundaries/symlink escape, serialized jobs, ASR tiers and caps, voice resolution, schema refusal, reference manifest checks, sanitized failure/recovery. The installer is checked via pure helpers (`cmakeFor`, `hfUrl`, `ggufUrl`, `proxyEnv`, `localArchive`) and a prepared-manifest plan fixture.
- Not covered: real model loading, intelligibility, latency, `--apply`, and the ModelScope/proxy download path on the host.

## Source evidence

- [Sherpa Node-addon installation](https://k2-fsa.github.io/sherpa/onnx/javascript-api/install.html)
- [SenseVoice class example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_asr_non_streaming_sense_voice.js)
- [Qwen3-ASR class example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_asr_non_streaming_qwen3_asr.js)
- [Native offline stream resampling](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-stream.cc)
- [Qwen3-ASR int8 files](https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/pretrained.html)
- [llama.cpp pinned TTS source and completion semantics](https://github.com/ggml-org/llama.cpp/blob/v0.8.0/tools/tts/tts.cpp)
- [GGUF snapshot file hashes](https://huggingface.co/api/models/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF/tree/ca27d74bc954b73dadab5b71ca265d87fc861a7c?recursive=true)

Runtime Apache/MIT licenses are not blanket licenses for every speech weight or voice. Retain each pinned artifact's own notices; current upstream SenseVoice links a custom FunASR model license. Cloning a real person's voice needs that person's consent regardless of model license.
