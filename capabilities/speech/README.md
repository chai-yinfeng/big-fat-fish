# Local file speech (internal Companion capability)

This is a trusted Host adapter, not a model-facing filesystem or cloning tool. No microphone, speaker, CUDA, cloud API, live-audio UI, network download or second inference loop is used. The outer media capability owns artifact IDs, access control, codecs and outgoing-channel receipts; it passes only authorized local paths to this internal runner.

## Interface

```js
import { createLocalSpeechRunner } from './capabilities/speech/runner.js';
const speech = createLocalSpeechRunner({ configFile: '/absolute/operator/speech.json' });
await speech.transcribe({ inputFile: '/allowed-media/input.wav', quality: 'light' });
await speech.synthesize({ text: '你好。', outputFile: '/speech-work/new-output.wav', quality: 'heavy', voiceProfile: 'default' });
```

- `transcribe` returns `{text,model,durationMs,derived:true}`. The result is machine transcription, not a verified literal user statement. `durationMs` is audio duration, not processing time. Input must already be **mono PCM16 RIFF WAV**, with its real sample rate between 8 and 48kHz, at most 120 seconds for light ASR and 30 seconds for heavy ASR (16MiB file ceiling). The wrapper passes the real `readWave` rate to `acceptWaveform`; sherpa's existing native OfflineStream resamples to the model's 16kHz feature rate. This is not a newly written resampler, and 24kHz QQ WAV is not rejected merely for its rate. QQ AMR/SILK/Opus decoding still belongs to the media boundary; an extension is not proof of codec.
- `synthesize` returns `{model,durationMs,sampleRate,mime:'audio/wav'}` only after a valid, nonempty WAV exists. The output path must be new and below `workRoot`. Sending this file and recording a successful QQ receipt are separate operations; WAV generation alone does not prove QQ playback.
- `language` defaults to `auto`; SenseVoice accepts the supported language hint. The Qwen3 sherpa backend currently uses its model's automatic language identification; this wrapper does not claim an explicit language-forcing feature for that backend.
- Missing config/runtime/weights gives `SPEECH_NOT_CONFIGURED`; disabled models give `SPEECH_MODEL_DISABLED`, without silent fallback. `status()` distinguishes component presence, enabled state and a matching operator CPU-benchmark admission record. `verified:true` only refers to that bounded synthetic benchmark, never human-auditioned quality, long-form reliability or realtime performance. Heavy defaults are disabled until explicit admission.
- Each runner serializes its requests. The trusted caller should keep one runner per product process. Each request launches one child that loads only the selected model, then exits. Heavy TTS invokes the registered native CLI in that process group. Timeout kills the whole group, including native descendants. Successful child exit is collected before a result is released. Both methods accept an optional trusted `AbortSignal`: already-cancelled/queued jobs never start a child, and active cancellation kills the whole process group and returns `SPEECH_CANCELLED`, removing partial output. The signal is never serialized into the JSON job.
- Configuration, executable/module locations, model paths and the synthetic reference are trusted operator inputs, never LLM arguments. Stderr and native prompt logs are not returned. Child environment excludes provider credentials. Native TTS receives a private temporary prompt file, not reply text in process arguments; the parent removes it even after timeout.
- `workerFile` is a constructor-only test seam. It is not an operator JSON field or an external tool parameter.

## Four registered engines

| Operation | Light (default) | Heavy (explicit request) |
|---|---|---|
| ASR | sherpa SenseVoiceSmall 2024-07-17 int8 | sherpa Qwen3-ASR-0.6B 2026-03-25 int8 |
| TTS | sherpa Kokoro v1.1 Chinese/English int8 | llama.cpp Qwen3-TTS-1.7B Base Q4_K_M + Q8 mmproj |

All sherpa configs fix `provider:'cpu'`, debug off and two threads by default. Kokoro uses the actual Node-addon class API (`OfflineTts`, `GenerationConfig`, `writeWave`); ASR uses `OfflineRecognizer` and object-form `acceptWaveform`, not legacy WASM APIs. The pinned npm release is `sherpa-onnx-node@2.0.1` with its matching Linux ARM64 optional package.

Heavy TTS is **Base using a synthetic reference**, not CustomVoice/VoiceDesign and not a general voice-cloning API. The only public `voiceProfile` is `default`. Its initial Kokoro speaker index is a reproducible, **not yet auditioned** benchmark choice, not a recorded user preference.

### Synthetic reference setup

After the operator has installed and verified the Kokoro components, run explicitly:

```sh
node capabilities/speech/setup-reference.mjs --config /absolute/operator/speech.json
```

This asks the light runner to speak one fixed public sentence, records the matching text, origin, Kokoro model/speaker, audio metadata and SHA256 beside the reference, and preserves a matching existing reference. It does not consume any QQ/audio input. Heavy TTS requires this matching `kokoro-local` record and its WAV hash; it cannot take a reference path, uploaded voice, speaker ID, prompt text or clone request from the model. Voice changes require operator configuration and regeneration of this synthetic reference, with human audition handled outside the runner.

The pinned `llama-tts` v0.8.0 demo exits 0 even at its frame limit. This wrapper therefore parses its version-specific completion summary and requires **0 < generated frames < maxFrames** before accepting output. Reaching the limit, missing completion summary, nonzero exit or timeout is a failure and the partial output is removed. It does not claim completeness from the existence of a WAV. Its upstream explicitly calls this binary a playground rather than production-ready; the wrapper's boundaries do not turn it into a verified production speech engine.

## Operator preparation and later installation

`ops/prepare-speech.mjs` only creates private directories, a configuration and a model provenance manifest. It does **not** install packages, download weights, generate references or call models. Existing operator config is preserved. Default locations:

- runtime: `~/.local/opt/companion/speech-node`
- models: `base/speech-models`
- work and synthetic reference: `base/speech-data`
- input: `base/media-data`

After explicit installation authorization, the isolated npm prefix can install `sherpa-onnx-node@2.0.1` with the private Node24 runtime. Do not use the Mac plugin profile, global npm, or assume Ubuntu26's Python3.14 wheels. The model manifest contains download sources, pending archive digests, licenses and fixed GGUF SHA256 values. Download each selected archive only once, inspect its actual extracted layout/LICENSE and record its digest; do not manufacture an expected checksum for mutable GitHub release assets. The config points to extracted files, not remote IDs, and no `from_pretrained` downloader runs here.

Native TTS uses upstream `ggml-org/llama.cpp` **v0.8.0**, commit `8642541b255bfb5dc39cd351a178be09013a55d6`. CPU-only build example (commands for later authorized setup, not performed by preparation):

```sh
cmake -S /trusted/llama.cpp -B /trusted/llama.cpp/build \
  -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF -DGGML_VULKAN=OFF -DGGML_METAL=OFF
cmake --build /trusted/llama.cpp/build --target llama-tts -j2
```

Register its absolute executable path in config. Runtime fixes `--device none`, `-ngl 0`, `--no-mmproj-offload`; no GPU is assumed for either talker or codec. The two GGUF files must both be present:

- `Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf`: 1,035,965,280 bytes; SHA256 `8d18c94acb2addd042f97da63c98be144eafa76d0d9495177eab65130cf85129`
- `mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf`: 446,422,912 bytes; SHA256 `6fd65188839bcd6ecc91b277ad471e22a0edfada4699a0fe82f1165c18cfcce2`

The fixed GGUF snapshot is `ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF@ca27d74bc954b73dadab5b71ca265d87fc861a7c`. Archive/file bytes are **not RSS or a latency benchmark**. The current VM has no proven realtime Qwen result. Full precision Qwen1.7B PyTorch variants are not the selected runtime and exceed this VM's comfortable memory budget. Never keep all four models resident, automatically run light+heavy for comparison, or mask OOM by falling back to an unauthorized cloud API.

## Test coverage / current limits

- `node --test capabilities/speech/runner.test.js` uses a fake child: path boundaries/symlink escape, serialized jobs, missing engine, sanitized failure/recovery. The installer is checked only via syntax and a temporary `--plan` fixture.
- Not covered: real model loading, intelligibility, latency or `--apply`. Benchmark procedure for after installation approval:

After installation approval, perform one public 5–10 second Chinese input and one short public TTS sentence per selected engine. Record cold load + end-to-end time, a second inference **in the same process** if evaluating warm behavior, peak RSS, output duration, omissions/intelligibility, and RTF (`processing seconds / audio seconds`). Re-launching the CLI is not a warm-model benchmark. `/usr/bin/time -v` can record peak RSS when GNU time is already available. Use the runner's 180-second timeout and bounded inputs; timeout/OOM/incomplete output keeps that heavy option unavailable, not falsely successful. Do not write benchmark speech into the persona's memory.

## Explicit private installer (not run during development)

The installer defaults to `--plan`: it validates an existing canonical `companion-world-v1` root and its Authority marker, reports components/estimated disk, and performs **no network request or write**. Missing speech config is reported as `prepared:false`; only `--apply` may invoke the preparation helper. A Linux arm64 or x64 private **Node24** process is required for applying; npm installs the matching `sherpa-onnx-linux-<arch>` native package and the installer requires it. No apt/sudo, system Node replacement, profile edit, service restart, inference, synthetic reference generation or persona reset is performed.

```sh
# In the complete production release; this command is still read-only.
"$HOME/.local/opt/companion/bin/node" /absolute/release/ops/install-speech.mjs --plan --models all
# Only after the user explicitly authorizes downloads/install/build:
"$HOME/.local/opt/companion/bin/node" /absolute/release/ops/install-speech.mjs --apply --models light
# Later, after authorizing the heavy downloads/build:
"$HOME/.local/opt/companion/bin/node" /absolute/release/ops/install-speech.mjs --apply --models all
# Optional where huggingface.co is unreachable (e.g. home-agent): fetch the same pinned
# revisions from the mirror; sizes and sha256 are still checked against the manifest.
"$HOME/.local/opt/companion/bin/node" /absolute/release/ops/install-speech.mjs --apply --models all --hf-endpoint https://hf-mirror.com
```

`--hf-endpoint` accepts only `https://huggingface.co` (default) or `https://hf-mirror.com`. It rewrites only `huggingface.co` download URLs; recorded sources stay the canonical huggingface.co URLs. The upstream model card has no published digest, so a mirrored copy is recorded as observed only.

`--models light` installs the pinned private npm runtime (sherpa2.0.1 + sharp0.35.5), SenseVoice and Kokoro only; `all` additionally installs Qwen3-ASR int8, the two pinned Qwen3-TTS GGUFs, and builds the native TTS CLI. Default selection is `all`, explicitly shown by the plan. Npm uses its private Node's own CLI with `--ignore-scripts --omit=dev`, fixed public registry, private cache, and no user/global npm config. Its generated lock digest is recorded.

Model sources come from the prepared speech manifest and must match the registered public sources/revision. Downloads are cached privately; archive SHA256 values are recorded as **observed**, not fabricated publisher verification. The known GGUF hashes and portable CMake hash are checked strictly. Tar extraction uses Python standard `tarfile` with `filter='data'` plus preflight relative-path/type/link checks; the extracted top-level folder must match the registered package. Archive LICENSE/data files are preserved. Existing model directories are never overwritten: installer-owned receipts can resume; an unknown preexisting directory stops for operator inspection. Failed partial downloads/staging directories are left private for diagnosis, not recursively deleted by guessed paths.

Because the host may lack CMake, `all` uses [official CMake 4.4.5 Linux aarch64 or x86_64](https://github.com/Kitware/CMake/releases/tag/v4.4.5) (chosen by host architecture) in the private runtime only. The archive hashes (aarch64 `301d5063ab259577c1b57ce5490b1aab9ea5c56dc4c822f73499553dab94925f`, x86_64 `ed85135c5a5135b45e50423cb406dea04ca3338da0b8ef3c9ede963559680be0`) were checked against the [publisher checksum list](https://github.com/Kitware/CMake/releases/download/v4.4.5/cmake-4.4.5-SHA-256.txt). It clones only the public pinned llama.cpp tag, verifies the exact commit and clean tracked source, selects Unix Makefiles (no Ninja required), disables CUDA/Vulkan/Metal/OpenSSL, and builds only `llama-tts -j2`. Source and license remain private alongside the build.

Plan disk estimates are **2–3GiB light**, **8–12GiB all**, including retained download cache and native source/build. They are planning reserves, not measured installation sizes or RAM. The script requires at least 3/12GiB currently free before the respective apply. Its private installation metadata records observed digests, component steps, npm lock hash and `inferenceVerified:false`; failures print fixed codes only. No claim is made that a successful compilation yields acceptable Chinese TTS latency or correctness: run the separate synthetic-reference step and small benchmark only after installation and human approval.

## Source evidence

- [Sherpa Node-addon installation / ARM support](https://k2-fsa.github.io/sherpa/onnx/javascript-api/install.html)
- [Actual SenseVoice class example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_asr_non_streaming_sense_voice.js)
- [Native offline stream resampling implementation](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-stream.cc)
- [Actual Qwen3-ASR class example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_asr_non_streaming_qwen3_asr.js)
- [Actual Kokoro class example](https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/test_tts_non_streaming_kokoro_zh_en_lexicon.js)
- [Kokoro bundles](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html)
- [Qwen3-ASR int8 files](https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/pretrained.html)
- [llama.cpp pinned TTS source and completion semantics](https://github.com/ggml-org/llama.cpp/blob/v0.8.0/tools/tts/tts.cpp)
- [GGUF metadata and immutable snapshot file hashes](https://huggingface.co/api/models/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF/tree/ca27d74bc954b73dadab5b71ca265d87fc861a7c?recursive=true)

Runtime Apache/MIT licenses are not blanket licenses for every speech weight, voice or phonemizer. Retain each pinned artifact's own notices. In particular, current upstream SenseVoice links a custom FunASR model license; Kokoro model Apache2 does not erase bundled espeak/data terms.
