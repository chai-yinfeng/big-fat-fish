#!/usr/bin/env python3
"""Standalone HTTP wrapper around Microsoft Edge's online text-to-speech.

The service is deliberately small and DSH-independent:

    POST /tts     {"text": "...", "voice": "zh-CN-XiaoxiaoNeural"} -> audio/mpeg
    GET  /voices  optional ?locale=zh-CN -> {"ok": true, "voices": [...]}
    GET  /health  -> {"ok": true, "service": "edge-tts", "version": "..."}

It binds 127.0.0.1 by default. No API key is needed, but Edge's service is a
network dependency and may be unavailable offline.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import signal
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import edge_tts

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9003
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
MAX_BODY_BYTES = 64 * 1024
MAX_TEXT_CHARS = 4000
VOICE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$")
PERCENT_PATTERN = re.compile(r"^[+-]\d{1,3}%$")
HZ_PATTERN = re.compile(r"^[+-]\d{1,3}Hz$")

STARTED_AT = time.monotonic()
_VOICES_LOCK = threading.Lock()
_VOICES_CACHE: dict[str, object] = {"at": 0.0, "voices": []}


class BadRequest(Exception):
    """Client input that the service refuses before touching the network."""


def _json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _validate_text(value: object, max_chars: int) -> str:
    if not isinstance(value, str):
        raise BadRequest("text must be a string")
    text = value.strip()
    if text == "":
        raise BadRequest("text must not be empty")
    if len(text) > max_chars:
        raise BadRequest(f"text is too long (max {max_chars} characters)")
    return text


def _validate_voice(value: object) -> str:
    # "auto" lets one companion voice setting work across providers: each
    # provider maps auto to its own default voice.
    if value is None or value == "" or value == "auto":
        return DEFAULT_VOICE
    if not isinstance(value, str) or not VOICE_PATTERN.fullmatch(value):
        raise BadRequest("voice must look like zh-CN-XiaoxiaoNeural, or use auto")
    return value


def _validate_rate(value: object) -> str:
    if value is None:
        return "+0%"
    if not isinstance(value, str) or not PERCENT_PATTERN.fullmatch(value):
        raise BadRequest("rate must look like +10% or -5%")
    return value


def _validate_volume(value: object) -> str:
    if value is None:
        return "+0%"
    if not isinstance(value, str) or not PERCENT_PATTERN.fullmatch(value):
        raise BadRequest("volume must look like +10% or -5%")
    return value


def _validate_pitch(value: object) -> str:
    if value is None:
        return "+0Hz"
    if not isinstance(value, str) or not HZ_PATTERN.fullmatch(value):
        raise BadRequest("pitch must look like +5Hz or -2Hz")
    return value


async def _synthesize(text: str, voice: str, rate: str, volume: str, pitch: str) -> bytes:
    communicate = edge_tts.Communicate(
        text,
        voice,
        rate=rate,
        volume=volume,
        pitch=pitch,
        boundary="SentenceBoundary",
    )
    chunks: list[bytes] = []
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio":
            data = chunk.get("data")
            if isinstance(data, (bytes, bytearray)) and data:
                chunks.append(bytes(data))
    audio = b"".join(chunks)
    if not audio:
        raise RuntimeError("edge-tts returned no audio")
    return audio


async def _load_voices() -> list[dict[str, object]]:
    raw = await edge_tts.list_voices()
    voices: list[dict[str, object]] = []
    for entry in raw:
        short_name = entry.get("ShortName")
        if not isinstance(short_name, str) or short_name == "":
            continue
        voices.append(
            {
                "shortName": short_name,
                "locale": entry.get("Locale"),
                "localeName": entry.get("LocaleName"),
                "gender": entry.get("Gender"),
                "friendlyName": entry.get("FriendlyName"),
                "personalities": entry.get("VoiceTag", {}).get("VoicePersonalities", []),
            }
        )
    voices.sort(key=lambda item: str(item["shortName"]))
    return voices


def get_voices(cache_seconds: int) -> list[dict[str, object]]:
    with _VOICES_LOCK:
        now = time.monotonic()
        cached = _VOICES_CACHE.get("voices")
        cached_at = float(_VOICES_CACHE.get("at") or 0.0)
        if isinstance(cached, list) and cached and now - cached_at < cache_seconds:
            return cached
        voices = asyncio.run(_load_voices())
        _VOICES_CACHE["voices"] = voices
        _VOICES_CACHE["at"] = now
        return voices


def filter_voices(voices: list[dict[str, object]], locale: str | None) -> list[dict[str, object]]:
    if not locale:
        return voices
    needle = locale.strip().lower()
    if needle == "":
        return voices
    return [
        voice
        for voice in voices
        if isinstance(voice.get("locale"), str)
        and str(voice["locale"]).lower().startswith(needle)
    ]


class EdgeTtsHandler(BaseHTTPRequestHandler):
    server_version = "companion-edge-tts/0.1"
    protocol_version = "HTTP/1.1"

    # Set by main() before the server starts listening.
    max_text_chars = MAX_TEXT_CHARS
    voices_cache_seconds = 3600

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("[edge-tts] " + (fmt % args) + "\n")

    def _send_headers(self, status: int, content_type: str, length: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")

    def _send_json(self, status: int, payload: object) -> None:
        body = _json_bytes(payload)
        self._send_headers(status, "application/json; charset=utf-8", len(body))
        self.end_headers()
        self.wfile.write(body)

    def _send_audio(self, audio: bytes, voice: str, elapsed_ms: int) -> None:
        self._send_headers(HTTPStatus.OK, "audio/mpeg", len(audio))
        self.send_header("X-Voice", voice)
        self.send_header("X-Duration-Ms", str(elapsed_ms))
        self.end_headers()
        self.wfile.write(audio)

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._send_headers(HTTPStatus.NO_CONTENT, "text/plain; charset=utf-8", 0)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "service": "edge-tts",
                    "version": getattr(edge_tts, "__version__", "unknown"),
                    "uptimeSeconds": round(time.monotonic() - STARTED_AT, 1),
                    "defaultVoice": DEFAULT_VOICE,
                },
            )
            return
        if parsed.path == "/voices":
            locale = parse_qs(parsed.query).get("locale", [None])[0]
            try:
                voices = filter_voices(get_voices(self.voices_cache_seconds), locale)
            except Exception as error:  # noqa: BLE001 - surfaced as a 502 payload
                self._send_json(
                    HTTPStatus.BAD_GATEWAY,
                    {"ok": False, "error": f"failed to list voices: {str(error)[:300]}"},
                )
                return
            self._send_json(
                HTTPStatus.OK,
                {"ok": True, "count": len(voices), "voices": voices},
            )
            return
        self._send_json(
            HTTPStatus.NOT_FOUND,
            {"ok": False, "error": "not found; use GET /health, GET /voices or POST /tts"},
        )

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        if parsed.path != "/tts":
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        try:
            payload = self._read_json()
            text = _validate_text(payload.get("text"), self.max_text_chars)
            voice = _validate_voice(payload.get("voice"))
            rate = _validate_rate(payload.get("rate"))
            volume = _validate_volume(payload.get("volume"))
            pitch = _validate_pitch(payload.get("pitch"))
        except BadRequest as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
            return
        except Exception as error:  # noqa: BLE001 - malformed body
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": f"invalid JSON body: {str(error)[:300]}"},
            )
            return

        started = time.monotonic()
        try:
            audio = asyncio.run(_synthesize(text, voice, rate, volume, pitch))
        except Exception as error:  # noqa: BLE001 - upstream failure
            self.log_message("synthesis failed: %s", str(error)[:300])
            self._send_json(
                HTTPStatus.BAD_GATEWAY,
                {"ok": False, "error": f"edge-tts failed: {str(error)[:300]}"},
            )
            return
        elapsed_ms = int((time.monotonic() - started) * 1000)
        self.log_message(
            "synthesized %d chars -> %d bytes in %d ms (%s)",
            len(text),
            len(audio),
            elapsed_ms,
            voice,
        )
        self._send_audio(audio, voice, elapsed_ms)

    def _read_json(self) -> dict[str, object]:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise BadRequest("Content-Length is required")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise BadRequest("Content-Length must be an integer") from error
        if length <= 0:
            raise BadRequest("request body is required")
        if length > MAX_BODY_BYTES:
            raise BadRequest(f"request body is too large (max {MAX_BODY_BYTES} bytes)")
        body = self.rfile.read(length)
        try:
            parsed = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BadRequest(f"invalid JSON body: {error}") from error
        if not isinstance(parsed, dict):
            raise BadRequest("JSON body must be an object")
        return parsed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Minimal local HTTP service for edge-tts.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="bind port (default 9003; 0 picks a free port)")
    parser.add_argument("--max-text-chars", type=int, default=MAX_TEXT_CHARS)
    parser.add_argument("--voices-cache-seconds", type=int, default=3600)
    args = parser.parse_args(argv)

    EdgeTtsHandler.max_text_chars = max(1, args.max_text_chars)
    EdgeTtsHandler.voices_cache_seconds = max(0, args.voices_cache_seconds)

    server = ThreadingHTTPServer((args.host, args.port), EdgeTtsHandler)
    server.daemon_threads = True
    port = server.server_address[1]

    def shutdown(_signum: int, _frame: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(f"EDGE_TTS_PORT={port}", flush=True)
    print(f"EDGE_TTS_URL=http://{args.host}:{port}", flush=True)
    sys.stderr.write(
        f"[edge-tts] listening on http://{args.host}:{port} "
        f"(edge-tts {getattr(edge_tts, '__version__', 'unknown')}, default voice {DEFAULT_VOICE})\n"
    )
    sys.stderr.flush()
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        sys.stderr.write("[edge-tts] stopped\n")
        sys.stderr.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
