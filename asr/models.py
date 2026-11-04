"""One-click model download/status for SenseVoice and Silero VAD."""

from __future__ import annotations

import shutil
import tarfile
import threading
import time
import urllib.request
from pathlib import Path

SENSEVOICE_ARCHIVE = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2"
SENSEVOICE_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    + SENSEVOICE_ARCHIVE
)
ZIPFORMER_ARCHIVE = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2"
ZIPFORMER_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    + ZIPFORMER_ARCHIVE
)
VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
USER_AGENT = "companion-asr-gateway/0.1"


class ModelManager:
    def __init__(self, config) -> None:
        self.config = config
        self._lock = threading.Lock()
        self._state = {
            "installing": False,
            "done": False,
            "name": None,
            "target": None,
            "downloaded": 0,
            "total": 0,
            "error": None,
            "startedAt": None,
            "finishedAt": None,
        }

    def status(self) -> dict:
        model = self.config.sensevoice_model
        tokens = self.config.sensevoice_tokens
        vad = self.config.vad_model
        return {
            "modelsDir": str(self.config.models_dir),
            "sensevoice": {
                "installed": model.is_file() and tokens.is_file(),
                "model": str(model),
                "tokens": str(tokens),
                "bytes": model.stat().st_size if model.is_file() else 0,
                "version": SENSEVOICE_ARCHIVE,
            },
            "vad": {
                "installed": vad.is_file(),
                "model": str(vad),
                "bytes": vad.stat().st_size if vad.is_file() else 0,
            },
            "zipformer": {
                "installed": self.config.zipformer_ready(),
                "dir": str(self.config.zipformer_dir),
                "bytes": self.config.zipformer_encoder.stat().st_size
                if self.config.zipformer_encoder.is_file() else 0,
                "version": ZIPFORMER_ARCHIVE,
            },
            "install": dict(self._state),
        }

    def install_in_background(self, target: str = "all") -> dict:
        if target not in {"all", "sensevoice", "zipformer"}:
            raise ValueError("target must be all, sensevoice or zipformer")
        with self._lock:
            if self._state["installing"]:
                return dict(self._state)
            self._state.update(
                {
                    "installing": True,
                    "done": False,
                    "name": None,
                    "target": target,
                    "downloaded": 0,
                    "total": 0,
                    "error": None,
                    "startedAt": time.time(),
                    "finishedAt": None,
                }
            )
            thread = threading.Thread(target=self._install, args=(target,), daemon=True)
            thread.start()
            return dict(self._state)

    def _set(self, **patch) -> None:
        self._state.update(patch)

    def _install(self, target: str) -> None:
        try:
            self.config.models_dir.mkdir(parents=True, exist_ok=True)
            if target in {"all", "sensevoice"} and not (
                self.config.sensevoice_model.is_file() and self.config.sensevoice_tokens.is_file()
            ):
                archive = self.config.models_dir / SENSEVOICE_ARCHIVE
                self._download("sensevoice", SENSEVOICE_URL, archive)
                self._extract_sensevoice(archive)
                archive.unlink(missing_ok=True)
            if target in {"all", "zipformer"} and not self.config.zipformer_ready():
                archive = self.config.models_dir / ZIPFORMER_ARCHIVE
                self._download("zipformer", ZIPFORMER_URL, archive)
                self._extract_zipformer(archive)
                archive.unlink(missing_ok=True)
            if not self.config.vad_model.is_file():
                self._download("vad", VAD_URL, self.config.vad_model)
            self._set(installing=False, done=True, finishedAt=time.time(), downloaded=0, total=0)
            print(f"[asr] models installed ({target})", flush=True)
        except Exception as error:  # noqa: BLE001 - reported to the UI
            self._set(installing=False, error=str(error)[:500], finishedAt=time.time())
            print(f"[asr] model install failed: {error}", flush=True)

    def _download(self, name: str, url: str, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(target.suffix + ".part")
        self._set(name=name, downloaded=0, total=0, error=None)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response, temp.open("wb") as output:
            total = int(response.headers.get("content-length") or 0)
            self._set(total=total)
            downloaded = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                downloaded += len(chunk)
                self._set(downloaded=downloaded)
            if total and downloaded != total:
                raise RuntimeError(f"{name} download incomplete: {downloaded}/{total}")
        temp.replace(target)

    def _extract_sensevoice(self, archive: Path) -> None:
        target = self.config.sensevoice_dir
        target.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, "r:bz2") as tar:
            members = [m for m in tar.getmembers() if m.isfile()]
            wanted = {}
            for member in members:
                name = Path(member.name).name
                if name in {"model.int8.onnx", "tokens.txt", "model.onnx"}:
                    wanted[name] = member
            if "model.int8.onnx" not in wanted or "tokens.txt" not in wanted:
                raise RuntimeError("SenseVoice archive did not contain model.int8.onnx and tokens.txt")
            for name in ("model.int8.onnx", "tokens.txt"):
                member = wanted[name]
                source = tar.extractfile(member)
                if source is None:
                    raise RuntimeError(f"cannot extract {name}")
                destination = target / name
                with source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                print(f"[asr] extracted {destination}", flush=True)

    def _extract_zipformer(self, archive: Path) -> None:
        target = self.config.zipformer_dir
        target.mkdir(parents=True, exist_ok=True)
        wanted_names = {
            "encoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.onnx",
            "joiner-epoch-99-avg-1.int8.onnx",
            "tokens.txt",
        }
        with tarfile.open(archive, "r:bz2") as tar:
            wanted = {}
            for member in tar.getmembers():
                if not member.isfile():
                    continue
                name = Path(member.name).name
                if name in wanted_names:
                    wanted[name] = member
            missing = wanted_names - set(wanted)
            if missing:
                raise RuntimeError(f"Zipformer archive missing: {', '.join(sorted(missing))}")
            for name in sorted(wanted_names):
                member = wanted[name]
                source = tar.extractfile(member)
                if source is None:
                    raise RuntimeError(f"cannot extract {name}")
                destination = target / name
                with source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                print(f"[asr] extracted {destination}", flush=True)
