"""ASR providers: Qwen3-ASR (cloud streaming) and SenseVoice (local ONNX)."""

from __future__ import annotations

import os
import queue
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx
import dashscope
from dashscope.audio.asr import Recognition, RecognitionCallback, RecognitionResult

SAMPLE_RATE = 16_000
CHUNK_BYTES = 3_200  # 100 ms of 16 kHz int16 mono


class ProviderError(RuntimeError):
    pass


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        width = source.getsampwidth()
        rate = source.getframerate()
        frames = source.readframes(source.getnframes())
    if width != 2:
        raise ProviderError(f"unsupported WAV sample width: {width}")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE:
        samples = resample_linear(samples, rate, SAMPLE_RATE)
    return samples.astype(np.float32)


def resample_linear(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate or samples.size == 0:
        return samples
    duration = samples.size / float(source_rate)
    target_size = max(1, int(round(duration * target_rate)))
    source_index = np.linspace(0.0, samples.size - 1, num=target_size, dtype=np.float64)
    left = np.floor(source_index).astype(np.int64)
    right = np.minimum(left + 1, samples.size - 1)
    fraction = (source_index - left).astype(np.float32)
    return (samples[left] * (1.0 - fraction) + samples[right] * fraction).astype(np.float32)


def decode_audio_to_wav(data: bytes, mime: str = "audio/wav") -> Path:
    """Decode arbitrary upload bytes into a temporary 16 kHz mono WAV."""
    suffix = ".wav"
    if "webm" in mime:
        suffix = ".webm"
    elif "ogg" in mime or "opus" in mime:
        suffix = ".ogg"
    elif "mp4" in mime or "m4a" in mime:
        suffix = ".m4a"
    elif "mpeg" in mime or "mp3" in mime:
        suffix = ".mp3"
    temporary = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    temporary.write(data)
    temporary.close()
    source = Path(temporary.name)
    target = source.with_suffix(".16k.wav")
    try:
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(source), "-ar", str(SAMPLE_RATE), "-ac", "1",
                "-f", "wav", str(target),
            ],
            check=True,
            timeout=60,
        )
        return target
    except FileNotFoundError as error:
        raise ProviderError("ffmpeg is required to decode non-WAV audio") from error
    except subprocess.CalledProcessError as error:
        raise ProviderError(f"ffmpeg failed: {error}") from error


def pcm16_bytes(samples: np.ndarray) -> bytes:
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * 32767.0).astype(np.int16).tobytes()


def pcm16_array(data: bytes) -> np.ndarray:
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def energy_trim(samples: np.ndarray, threshold: float = 0.008) -> np.ndarray:
    if samples.size == 0:
        return samples
    frame = 320
    count = samples.size // frame
    if count == 0:
        return samples
    frames = samples[: count * frame].reshape(count, frame)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    active = np.where(rms > max(threshold, float(rms.max()) * 0.1))[0]
    if active.size == 0:
        return np.zeros(0, dtype=np.float32)
    start = max(0, int(active[0]) * frame - SAMPLE_RATE // 5)
    end = min(samples.size, (int(active[-1]) + 1) * frame + SAMPLE_RATE // 5)
    return samples[start:end].astype(np.float32)


def vad_trim(samples: np.ndarray, config) -> np.ndarray:
    """Trim silence with sherpa-onnx Silero VAD, falling back to energy VAD."""
    if not config.vad_ready():
        return energy_trim(samples)
    try:
        vad_config = sherpa_onnx.VadModelConfig()
        vad_config.sample_rate = SAMPLE_RATE
        vad_config.silero_vad.model = str(config.vad_model)
        vad_config.silero_vad.threshold = 0.5
        vad_config.silero_vad.min_silence_duration = 0.25
        vad_config.silero_vad.min_speech_duration = 0.25
        vad_config.silero_vad.max_speech_duration = 60
        detector = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=120)
        # Feed in small chunks: one huge accept_waveform call only emits the
        # final segment in sherpa-onnx 2.0.
        array = samples.astype(np.float32)
        for offset in range(0, array.size, 1600):
            detector.accept_waveform(array[offset:offset + 1600])
        detector.flush()
        segments = []
        while not detector.empty():
            segment = detector.front
            segments.append(np.asarray(segment.samples, dtype=np.float32))
            detector.pop()
        if not segments:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(segments).astype(np.float32)
    except Exception as error:  # noqa: BLE001 - VAD must not block ASR
        print(f"[asr] VAD failed, using energy trim: {error}", flush=True)
        return energy_trim(samples)


class SenseVoiceProvider:
    def __init__(self, config) -> None:
        self.config = config
        self._recognizer = None
        self._lock = threading.Lock()

    def available(self) -> bool:
        return self.config.sensevoice_ready()

    def _get_recognizer(self):
        if self._recognizer is None:
            self._recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(self.config.sensevoice_model),
                tokens=str(self.config.sensevoice_tokens),
                num_threads=2,
                use_itn=True,
                language=self.config.language,
            )
        return self._recognizer

    def transcribe(self, samples: np.ndarray) -> str:
        if not self.available() or samples.size == 0:
            return ""
        with self._lock:
            recognizer = self._get_recognizer()
            stream = recognizer.create_stream()
            stream.accept_waveform(SAMPLE_RATE, samples.astype(np.float32))
            recognizer.decode_stream(stream)
            text = getattr(stream.result, "text", "") or ""
            return text.strip()


def _clean_stream_text(text: str) -> str:
    return str(text or "").replace("@@", "").replace("▁", " ").strip()


class ZipformerStream:
    def __init__(self, provider: "ZipformerStreamingProvider") -> None:
        self.provider = provider
        self.recognizer = provider.recognizer()
        self.stream = self.recognizer.create_stream()

    def accept(self, samples: np.ndarray) -> str:
        if samples.size:
            self.stream.accept_waveform(SAMPLE_RATE, samples.astype(np.float32))
        self._decode()
        return self.partial()

    def _decode(self) -> None:
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)

    def partial(self) -> str:
        return _clean_stream_text(self.recognizer.get_result(self.stream))

    def finish(self) -> str:
        tail = np.zeros(int(0.5 * SAMPLE_RATE), dtype=np.float32)
        self.stream.accept_waveform(SAMPLE_RATE, tail)
        self.stream.input_finished()
        self._decode()
        return self.partial()


class ZipformerStreamingProvider:
    """Local true-streaming ASR (sherpa-onnx streaming Zipformer int8)."""

    def __init__(self, config) -> None:
        self.config = config
        self._recognizer = None
        self._lock = threading.Lock()

    def available(self) -> bool:
        return self.config.zipformer_ready()

    def recognizer(self):
        if self._recognizer is None:
            with self._lock:
                if self._recognizer is None:
                    self._recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                        tokens=str(self.config.zipformer_tokens),
                        encoder=str(self.config.zipformer_encoder),
                        decoder=str(self.config.zipformer_decoder),
                        joiner=str(self.config.zipformer_joiner),
                        num_threads=2,
                        sample_rate=SAMPLE_RATE,
                        feature_dim=80,
                        decoding_method="greedy_search",
                        enable_endpoint_detection=True,
                        rule1_min_trailing_silence=2.4,
                        rule2_min_trailing_silence=1.2,
                        provider="cpu",
                    )
        return self._recognizer

    def create_stream(self) -> ZipformerStream:
        return ZipformerStream(self)

    def transcribe(self, samples: np.ndarray) -> str:
        if not self.available() or samples.size == 0:
            return ""
        stream = self.create_stream()
        stream.accept(samples)
        return stream.finish()


class _QwenCallback(RecognitionCallback):
    def __init__(self, owner: "_QwenSession") -> None:
        self.owner = owner

    def on_event(self, result: RecognitionResult) -> None:  # type: ignore[override]
        try:
            sentence = result.get_sentence()
            text = sentence.get("text", "") if isinstance(sentence, dict) else ""
            if not text:
                return
            is_final = RecognitionResult.is_sentence_end(sentence)
            self.owner._on_text(text, is_final)
        except Exception as error:  # noqa: BLE001 - callback must not throw
            self.owner._on_error(str(error))

    def on_complete(self) -> None:  # type: ignore[override]
        self.owner._on_complete()

    def on_error(self, result) -> None:  # type: ignore[override]
        message = getattr(result, "message", None) or str(result)
        self.owner._on_error(message)

    def on_close(self) -> None:  # type: ignore[override]
        self.owner._on_complete()


class _QwenSession:
    def __init__(self, model: str) -> None:
        self.model = model
        self.events: queue.Queue = queue.Queue()
        self.done = threading.Event()
        self.error: str | None = None
        self.finals: list[str] = []
        self.partial = ""
        self._closed = False
        self._recognition = Recognition(
            model=model,
            callback=_QwenCallback(self),
            format="pcm",
            sample_rate=SAMPLE_RATE,
        )

    def _emit(self, kind: str, text: str, final: bool = False) -> None:
        self.events.put({"type": kind, "text": text, "final": final})

    def _on_text(self, text: str, is_final: bool) -> None:
        if is_final:
            self.finals.append(text)
            self.partial = ""
            self._emit("partial", "".join(self.finals), False)
        else:
            self.partial = text
            self._emit("partial", "".join(self.finals) + text, False)

    def _on_complete(self) -> None:
        self.done.set()

    def _on_error(self, message: str) -> None:
        self.error = message
        self.done.set()

    def start(self) -> None:
        self._recognition.start()

    def feed(self, data: bytes) -> None:
        if self._closed or not data:
            return
        self._recognition.send_audio_frame(data)

    def stop(self, timeout: float) -> str:
        if not self._closed:
            self._closed = True
            try:
                self._recognition.stop()
            except Exception as error:  # noqa: BLE001 - surfaced below
                self._on_error(str(error))
        self.done.wait(timeout=timeout)
        if self.error:
            raise ProviderError(self.error)
        final = "".join(self.finals).strip() or self.partial.strip()
        return final


class QwenProvider:
    def __init__(self, config) -> None:
        self.config = config
        if config.api_key:
            dashscope.api_key = config.api_key
        if config.ws_url:
            dashscope.base_websocket_api_url = config.ws_url
        self.models = [config.qwen_model]
        if self.config.qwen_model != "qwen3-asr-flash-realtime":
            self.models.append("qwen3-asr-flash-realtime")

    def available(self) -> bool:
        return bool(self.config.api_key)

    def open_session(self, model: str | None = None) -> _QwenSession:
        session = _QwenSession(model or self.models[0])
        session.start()
        return session

    def transcribe(self, samples: np.ndarray) -> tuple[str, str]:
        if not self.available() or samples.size == 0:
            return "", self.models[0]
        data = pcm16_bytes(samples)
        errors = []
        for model in self.models:
            try:
                session = self.open_session(model)
                for offset in range(0, len(data), CHUNK_BYTES):
                    session.feed(data[offset:offset + CHUNK_BYTES])
                text = session.stop(self.config.cloud_timeout_seconds)
                if text.strip():
                    return text.strip(), model
                errors.append(f"{model}: empty result")
            except Exception as error:  # noqa: BLE001 - try the fallback model
                errors.append(f"{model}: {error}")
        raise ProviderError("; ".join(errors) or "Qwen ASR failed")


VALID_PROVIDERS = ("qwen3", "sensevoice", "zipformer")


def normalize_providers(providers=None, provider: str = "auto") -> list[str]:
    """Ordered enabled provider names; legacy mode is accepted for old callers."""
    if isinstance(providers, list):
        ordered = [name for name in providers if name in VALID_PROVIDERS]
        # Preserve order but drop duplicates.
        seen = set()
        unique = []
        for name in ordered:
            if name in seen:
                continue
            seen.add(name)
            unique.append(name)
        return unique
    if provider == "local":
        return ["sensevoice"]
    if provider == "cloud":
        return ["qwen3"]
    return ["qwen3", "sensevoice"]


class AsrEngine:
    def __init__(self, config) -> None:
        self.config = config
        self.qwen = QwenProvider(config)
        self.sensevoice = SenseVoiceProvider(config)
        self.zipformer = ZipformerStreamingProvider(config)

    def final_from_samples(self, samples: np.ndarray, providers=None, provider: str = "auto") -> dict:
        started = time.monotonic()
        enabled = normalize_providers(providers, provider)
        trimmed = vad_trim(samples, self.config)
        result = {
            "text": "",
            "provider": None,
            "model": None,
            "alternative": None,
            "verified": False,
            "providers": enabled,
            "durationMs": 0,
            "vadTrimmedSamples": int(trimmed.size),
            "inputSamples": int(samples.size),
        }
        if trimmed.size == 0:
            result["durationMs"] = int((time.monotonic() - started) * 1000)
            return result
        cloud_enabled = "qwen3" in enabled and self.qwen.available()
        local_enabled = "sensevoice" in enabled and self.sensevoice.available()
        zipformer_enabled = "zipformer" in enabled and self.zipformer.available()
        cloud_text = ""
        cloud_model = None
        cloud_error = None
        zipformer_text = ""
        if zipformer_enabled and (not cloud_enabled or enabled[0] == "zipformer"):
            try:
                zipformer_text = self.zipformer.transcribe(trimmed)
            except Exception as error:  # noqa: BLE001 - fallback remains
                print(f"[asr] Zipformer failed: {error}", flush=True)
                zipformer_text = ""
        if cloud_enabled:
            try:
                cloud_text, cloud_model = self.qwen.transcribe(trimmed)
            except Exception as error:  # noqa: BLE001 - local fallback
                cloud_error = str(error)
                print(f"[asr] Qwen failed, falling back to SenseVoice: {error}", flush=True)
        local_text = ""
        if local_enabled:
            try:
                local_text = self.sensevoice.transcribe(trimmed)
            except Exception as error:  # noqa: BLE001 - reported in result
                print(f"[asr] SenseVoice failed: {error}", flush=True)
                local_text = ""
        if cloud_text:
            result.update({
                "text": cloud_text,
                "provider": "qwen3-asr",
                "model": cloud_model,
                "alternative": zipformer_text or local_text or None,
                "verified": bool(zipformer_text or local_text),
            })
        elif zipformer_text:
            result.update({
                "text": zipformer_text,
                "provider": "zipformer",
                "model": "zipformer-zh-14M-int8",
                "alternative": local_text or None,
                "verified": False,
            })
        elif local_text:
            result.update({
                "text": local_text,
                "provider": "sensevoice",
                "model": "sensevoice-int8",
                "verified": False,
            })
        if cloud_error:
            result["cloudError"] = cloud_error
        result["durationMs"] = int((time.monotonic() - started) * 1000)
        return result

    def final_from_wav(self, path: Path, providers=None, provider: str = "auto") -> dict:
        return self.final_from_samples(read_wav(path), providers, provider)
