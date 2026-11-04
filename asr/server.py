#!/usr/bin/env python3
"""Local ASR gateway: Qwen3-ASR streaming with SenseVoice/VAD fallback."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import queue
import sys
import tempfile
from pathlib import Path

from aiohttp import WSMsgType, web

from config import Config, DEFAULT_HOST, DEFAULT_PORT
from models import ModelManager
from providers import (
    AsrEngine,
    SAMPLE_RATE,
    decode_audio_to_wav,
    normalize_providers,
    pcm16_array,
    vad_trim,
)


class StreamSession:
    def __init__(self, engine: AsrEngine, language: str, providers=None, provider: str = "auto") -> None:
        self.engine = engine
        self.language = language
        self.providers = normalize_providers(providers, provider)
        self.pcm = bytearray()
        self.cloud = None
        self.cloud_error = None
        self.local_enabled = "sensevoice" in self.providers and engine.sensevoice.available()
        self.zipformer = None
        self.zipformer_text = ""
        if "zipformer" in self.providers and engine.zipformer.available():
            try:
                self.zipformer = engine.zipformer.create_stream()
            except Exception as error:  # noqa: BLE001 - other providers remain
                print(f"[asr] zipformer session failed: {error}", flush=True)
        if "qwen3" in self.providers and engine.qwen.available():
            try:
                self.cloud = engine.qwen.open_session()
            except Exception as error:  # noqa: BLE001 - local fallback
                self.cloud_error = str(error)
                print(f"[asr] cloud session failed: {error}", flush=True)

    def feed(self, data: bytes) -> None:
        self.pcm.extend(data)
        if self.zipformer is not None:
            try:
                self.zipformer_text = self.zipformer.accept(
                    pcm16_array(bytes(data))
                ) or self.zipformer_text
            except Exception as error:  # noqa: BLE001 - other providers remain
                print(f"[asr] zipformer feed failed: {error}", flush=True)
                self.zipformer = None
        if self.cloud is not None:
            try:
                self.cloud.feed(data)
            except Exception as error:  # noqa: BLE001 - keep accumulating locally
                self.cloud_error = str(error)

    def partial_provider(self) -> str | None:
        if self.cloud is not None and not self.cloud_error and self.providers[0] == "qwen3":
            return "qwen3"
        if self.zipformer is not None:
            return "zipformer"
        if self.local_enabled:
            return "sensevoice"
        return None

    def samples(self):
        return pcm16_array(bytes(self.pcm))

    def local_partial(self) -> str:
        if not self.local_enabled or not self.pcm:
            return ""
        trimmed = vad_trim(self.samples(), self.engine.config)
        if trimmed.size == 0:
            return ""
        return self.engine.sensevoice.transcribe(trimmed)

    def finish(self) -> dict:
        zipformer_text = self.zipformer_text
        if self.zipformer is not None:
            try:
                zipformer_text = self.zipformer.finish() or zipformer_text
            except Exception as error:  # noqa: BLE001 - other providers remain
                print(f"[asr] zipformer final failed: {error}", flush=True)
        cloud_text = ""
        cloud_model = None
        if self.cloud is not None:
            try:
                cloud_text = self.cloud.stop(self.engine.config.cloud_timeout_seconds)
                cloud_model = self.cloud.model
            except Exception as error:  # noqa: BLE001 - local fallback
                self.cloud_error = str(error)
                print(f"[asr] cloud final failed: {error}", flush=True)
        local_text = ""
        if self.local_enabled:
            try:
                trimmed = vad_trim(self.samples(), self.engine.config)
                if trimmed.size:
                    local_text = self.engine.sensevoice.transcribe(trimmed)
            except Exception as error:  # noqa: BLE001 - report only
                print(f"[asr] local final failed: {error}", flush=True)
        final = cloud_text or zipformer_text or local_text
        return {
            "text": final.strip(),
            "provider": (
                "qwen3-asr" if cloud_text
                else "zipformer" if zipformer_text
                else "sensevoice" if local_text
                else None
            ),
            "model": (
                cloud_model if cloud_text
                else "zipformer-zh-14M-int8" if zipformer_text
                else "sensevoice-int8" if local_text
                else None
            ),
            "alternative": (
                (zipformer_text or local_text).strip()
                if cloud_text and (zipformer_text or local_text) else None
            ),
            "verified": bool(cloud_text and (zipformer_text or local_text)),
            "providers": self.providers,
            **({"cloudError": self.cloud_error} if self.cloud_error else {}),
        }

    def close(self) -> None:
        if self.cloud is not None and not self.cloud.done.is_set():
            try:
                self.cloud.stop(3)
            except Exception:
                pass


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        response = web.Response(status=204)
    else:
        response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "content-type"
    return response


class AsrService:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.engine = AsrEngine(config)
        self.models = ModelManager(config)
        self._stream_lock = asyncio.Lock()

    async def health(self, _request: web.Request) -> web.Response:
        status = self.models.status()
        return web.json_response({
            "ok": True,
            "service": "companion-asr",
            "language": self.config.language,
            "qwen": {
                "configured": self.config.cloud_ready(),
                "model": self.config.qwen_model,
                "baseUrl": self.config.base_url,
            },
            "sensevoice": {
                "available": self.config.sensevoice_ready(),
                "installed": status["sensevoice"]["installed"],
                "bytes": status["sensevoice"]["bytes"],
            },
            "vad": {
                "available": self.config.vad_ready(),
                "installed": status["vad"]["installed"],
            },
            "zipformer": {
                "available": self.config.zipformer_ready(),
                "installed": status["zipformer"]["installed"],
                "bytes": status["zipformer"]["bytes"],
            },
            "models": status,
        })

    async def list_models(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True, **self.models.status()})

    async def install_models(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - empty body means install all
            body = {}
        target = str(body.get("target") or "all")
        try:
            state = self.models.install_in_background(target)
        except ValueError as error:
            return web.json_response({"ok": False, "error": str(error)}, status=400)
        return web.json_response({"ok": True, "install": state}, status=202)

    async def transcribe(self, request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except Exception as error:  # noqa: BLE001
            return web.json_response({"ok": False, "error": f"invalid JSON: {error}"}, status=400)
        encoded = body.get("audio")
        if not isinstance(encoded, str) or encoded == "":
            return web.json_response({"ok": False, "error": "audio (base64) is required"}, status=400)
        try:
            data = base64.b64decode(encoded, validate=True)
        except Exception as error:  # noqa: BLE001
            return web.json_response({"ok": False, "error": f"invalid base64: {error}"}, status=400)
        mime = str(body.get("mime") or "audio/wav")
        path = None
        try:
            path = decode_audio_to_wav(data, mime)
            provider = str(body.get("provider") or "auto")
            providers = body.get("providers")
            if not isinstance(providers, list):
                providers = None
            if providers is not None and any(name not in {"qwen3", "sensevoice", "zipformer"} for name in providers):
                return web.json_response({"ok": False, "error": "providers must contain qwen3, sensevoice and/or zipformer"}, status=400)
            if provider not in {"auto", "local", "cloud"}:
                return web.json_response({"ok": False, "error": "provider must be auto, local or cloud"}, status=400)
            result = await asyncio.to_thread(self.engine.final_from_wav, path, providers, provider)
            return web.json_response({"ok": True, **result})
        except Exception as error:  # noqa: BLE001
            return web.json_response({"ok": False, "error": str(error)[:500]}, status=502)
        finally:
            if path is not None:
                for candidate in (path, path.with_suffix(".wav")):
                    try:
                        candidate.unlink(missing_ok=True)
                    except OSError:
                        pass

    async def stream(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        if self._stream_lock.locked():
            await ws.send_json({"type": "error", "error": "another ASR stream is active"})
            await ws.close()
            return ws
        await self._stream_lock.acquire()
        session = None
        pump_task = None
        local_task = None
        recording = True
        try:
            first = await ws.receive()
            if first.type != WSMsgType.TEXT:
                await ws.send_json({"type": "error", "error": "start JSON is required"})
                return ws
            try:
                start = json.loads(first.data)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "error": "invalid start JSON"})
                return ws
            language = str(start.get("language") or self.config.language)
            provider = str(start.get("provider") or "auto")
            providers = start.get("providers")
            if not isinstance(providers, list):
                providers = None
            if providers is not None and any(name not in {"qwen3", "sensevoice", "zipformer"} for name in providers):
                await ws.send_json({"type": "error", "error": "providers must contain qwen3, sensevoice and/or zipformer"})
                return ws
            if provider not in {"auto", "local", "cloud"}:
                await ws.send_json({"type": "error", "error": "provider must be auto, local or cloud"})
                return ws
            session = StreamSession(self.engine, language, providers, provider)
            if not session.providers:
                await ws.send_json({"type": "error", "error": "no ASR provider enabled"})
                return ws
            if session.cloud is None and not session.local_enabled and session.zipformer is None:
                await ws.send_json({
                    "type": "error",
                    "error": "no ASR provider: install Zipformer/SenseVoice models or configure DASHSCOPE_API_KEY",
                })
                return ws
            await ws.send_json({
                "type": "ready",
                "cloud": session.cloud is not None,
                "sensevoice": self.engine.sensevoice.available(),
                "zipformer": session.zipformer is not None,
                "sampleRate": SAMPLE_RATE,
                "language": language,
                "provider": provider,
                "providers": session.providers,
            })

            async def pump_cloud() -> None:
                if session is None or session.cloud is None:
                    return
                while recording:
                    if session.cloud.error and not session.cloud_error:
                        session.cloud_error = session.cloud.error
                    try:
                        event = await asyncio.to_thread(session.cloud.events.get, True, 0.2)
                    except queue.Empty:
                        continue
                    if event and event.get("text") and session.partial_provider() == "qwen3":
                        await ws.send_json({
                            "type": "partial",
                            "text": event["text"],
                            "provider": "qwen3-asr",
                        })

            async def pump_local() -> None:
                last = ""
                while recording and session is not None:
                    provider = session.partial_provider()
                    if provider == "zipformer":
                        text = session.zipformer_text or ""
                        if text and text != last:
                            last = text
                            await ws.send_json({"type": "partial", "text": text, "provider": "zipformer"})
                        await asyncio.sleep(0.15)
                        continue
                    if provider == "sensevoice" and session.pcm:
                        try:
                            text = await asyncio.to_thread(session.local_partial)
                        except Exception:
                            text = ""
                        if text and text != last:
                            last = text
                            await ws.send_json({"type": "partial", "text": text, "provider": "sensevoice"})
                        await asyncio.sleep(self.config.partial_interval_seconds)
                        continue
                    await asyncio.sleep(0.1)

            if session.cloud is not None:
                pump_task = asyncio.create_task(pump_cloud())
            local_task = asyncio.create_task(pump_local())

            async for message in ws:
                if message.type == WSMsgType.BINARY:
                    session.feed(message.data)
                elif message.type == WSMsgType.TEXT:
                    try:
                        payload = json.loads(message.data)
                    except json.JSONDecodeError:
                        continue
                    if payload.get("type") == "stop":
                        break
                elif message.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                    break
            recording = False
            if pump_task is not None:
                pump_task.cancel()
            if local_task is not None:
                local_task.cancel()
            result = await asyncio.to_thread(session.finish)
            if not result.get("text"):
                await ws.send_json({"type": "final", **result, "error": "no speech recognized"})
            else:
                await ws.send_json({"type": "final", **result})
            return ws
        except Exception as error:  # noqa: BLE001
            print(f"[asr] stream failed: {error}", flush=True)
            try:
                await ws.send_json({"type": "error", "error": str(error)[:500]})
            except Exception:
                pass
            return ws
        finally:
            recording = False
            if pump_task is not None:
                pump_task.cancel()
            if local_task is not None:
                local_task.cancel()
            if session is not None:
                session.close()
            if self._stream_lock.locked():
                self._stream_lock.release()


def create_app(config: Config) -> web.Application:
    service = AsrService(config)
    app = web.Application(client_max_size=config.max_body_bytes, middlewares=[cors_middleware])
    app["service"] = service
    app.router.add_get("/health", service.health)
    app.router.add_get("/models", service.list_models)
    app.router.add_post("/models/install", service.install_models)
    app.router.add_post("/asr", service.transcribe)
    app.router.add_get("/asr/stream", service.stream)
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Companion ASR gateway")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=int(os.environ.get("ASR_PORT", DEFAULT_PORT)))
    parser.add_argument("--env-file", default=None)
    args = parser.parse_args(argv)
    if args.env_file:
        os.environ["ASR_ENV_FILE"] = args.env_file
    config = Config()
    app = create_app(config)
    print(f"ASR_PORT={args.port}", flush=True)
    print(f"ASR_URL=http://{args.host}:{args.port}", flush=True)
    sys.stderr.write(
        f"[asr] listening on http://{args.host}:{args.port} "
        f"(qwen {'configured' if config.cloud_ready() else 'missing'}, "
        f"sensevoice {'ready' if config.sensevoice_ready() else 'not installed'})\n"
    )
    sys.stderr.flush()
    web.run_app(app, host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
