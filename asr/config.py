"""Configuration and paths for the companion ASR gateway."""

from __future__ import annotations

import os
from pathlib import Path

DEFAULT_PORT = 9005
DEFAULT_HOST = "127.0.0.1"
DEFAULT_QWEN_MODEL = "qwen-audio-3.1-asr-flash-streaming"
FALLBACK_QWEN_MODEL = "qwen3-asr-flash-realtime"
DEFAULT_LANGUAGE = "zh"


def home_dir() -> Path:
    return Path(os.environ.get("DSH_HOME") or (Path.home() / ".dsh"))


def companion_dir() -> Path:
    return home_dir() / "companion"


def load_env_file(path: Path) -> None:
    try:
        source = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return
    except OSError as error:
        print(f"[asr] failed to read {path}: {error}", flush=True)
        return
    for line in source.splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        key, separator, value = text.partition("=")
        if not separator:
            continue
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and os.environ.get(key) is None:
            os.environ[key] = value


class Config:
    def __init__(self) -> None:
        env_file = Path(os.environ.get("ASR_ENV_FILE") or (companion_dir() / "dashscope.env"))
        load_env_file(env_file)
        self.env_file = env_file
        self.api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
        self.base_url = os.environ.get("DASHSCOPE_BASE_URL", "").strip().rstrip("/")
        self.ws_url = os.environ.get("DASHSCOPE_WS_URL", "").strip()
        self.qwen_model = os.environ.get("DASHSCOPE_ASR_MODEL", "").strip() or DEFAULT_QWEN_MODEL
        self.language = os.environ.get("ASR_LANGUAGE", "").strip() or DEFAULT_LANGUAGE
        self.models_dir = Path(os.environ.get("ASR_MODELS_DIR") or (companion_dir() / "models"))
        self.sensevoice_dir = self.models_dir / "sensevoice"
        self.sensevoice_model = Path(
            os.environ.get("SENSEVOICE_MODEL") or (self.sensevoice_dir / "model.int8.onnx")
        )
        self.sensevoice_tokens = Path(
            os.environ.get("SENSEVOICE_TOKENS") or (self.sensevoice_dir / "tokens.txt")
        )
        self.vad_model = Path(
            os.environ.get("SILERO_VAD_MODEL") or (self.models_dir / "silero_vad.onnx")
        )
        self.zipformer_dir = self.models_dir / "zipformer-streaming"
        self.zipformer_encoder = Path(
            os.environ.get("ZIPFORMER_ENCODER")
            or (self.zipformer_dir / "encoder-epoch-99-avg-1.int8.onnx")
        )
        self.zipformer_decoder = Path(
            os.environ.get("ZIPFORMER_DECODER")
            or (self.zipformer_dir / "decoder-epoch-99-avg-1.onnx")
        )
        self.zipformer_joiner = Path(
            os.environ.get("ZIPFORMER_JOINER")
            or (self.zipformer_dir / "joiner-epoch-99-avg-1.int8.onnx")
        )
        self.zipformer_tokens = Path(
            os.environ.get("ZIPFORMER_TOKENS") or (self.zipformer_dir / "tokens.txt")
        )
        self.max_body_bytes = int(os.environ.get("ASR_MAX_BODY_BYTES", str(20 * 1024 * 1024)))
        self.cloud_timeout_seconds = float(os.environ.get("ASR_CLOUD_TIMEOUT_SECONDS", "25"))
        self.partial_interval_seconds = float(os.environ.get("ASR_PARTIAL_INTERVAL_SECONDS", "1.5"))

    def cloud_ready(self) -> bool:
        return bool(self.api_key)

    def sensevoice_ready(self) -> bool:
        return self.sensevoice_model.is_file() and self.sensevoice_tokens.is_file()

    def vad_ready(self) -> bool:
        return self.vad_model.is_file()

    def zipformer_ready(self) -> bool:
        return (
            self.zipformer_encoder.is_file()
            and self.zipformer_decoder.is_file()
            and self.zipformer_joiner.is_file()
            and self.zipformer_tokens.is_file()
        )
