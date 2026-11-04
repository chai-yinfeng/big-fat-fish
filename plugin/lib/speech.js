/**
 * Local TTS + playback for the companion.
 *
 * Synthesis goes through the adapter plugin route first (`/companion/tts`,
 * which owns provider fallback) and then the standalone edge-tts service.
 * Playback is a local process (`afplay` on macOS, `ffplay` elsewhere); the
 * audio file is temporary and removed after the player exits.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { toAutoSpeechText, toSpeechText } from "./session.js";

const EDGE_FALLBACK_URL = "http://127.0.0.1:9003/tts";

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== ""))];
}

export function ttsUrls(config, getOrigin) {
  if (Array.isArray(config?.urls) && config.urls.length > 0) {
    return unique(config.urls);
  }
  const urls = [];
  if (config?.useAdapter !== false && typeof getOrigin === "function") {
    try {
      const origin = getOrigin();
      if (typeof origin === "string" && origin !== "") urls.push(`${origin}/companion/tts`);
    } catch {
      // The web server may not be listening yet; the direct edge URL still works.
    }
  }
  urls.push(EDGE_FALLBACK_URL);
  return unique(urls);
}

export function playerCommand(player, platform = process.platform) {
  const name = typeof player === "string" && player.trim() !== "" ? player.trim() : "auto";
  if (name === "auto") {
    return platform === "darwin"
      ? { command: "afplay", args: (file) => [file] }
      : { command: "ffplay", args: (file) => ["-nodisp", "-autoexit", "-loglevel", "quiet", file] };
  }
  if (name === "ffplay") {
    return { command: "ffplay", args: (file) => ["-nodisp", "-autoexit", "-loglevel", "quiet", file] };
  }
  if (name === "mpv") {
    return { command: "mpv", args: (file) => ["--no-video", "--really-quiet", file] };
  }
  // `afplay` and explicit custom commands take the file as their only argument.
  return { command: name, args: (file) => [file] };
}

function timedSignal(timeoutMs, external) {
  const timeout = AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 60_000));
  if (!external) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([external, timeout]);
  return timeout;
}

function describeError(error) {
  if (error instanceof AggregateError) {
    return error.errors.map((entry) => entry?.message ?? String(entry)).join("; ") || error.message;
  }
  return error?.message ?? String(error);
}

export function createSpeechService({
  config = {},
  getOrigin = undefined,
  log = () => {},
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  platform = process.platform,
  cacheDir,
} = {}) {
  let current = null;
  let disposed = false;
  const urlList = () => ttsUrls(config, getOrigin);

  async function synthesize(text, { voice = undefined, signal = undefined } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("fetch is required for TTS");
    if (typeof text !== "string" || text.trim() === "") throw new Error("TTS text must not be empty");
    const payload = {
      text,
      voice: voice || config.voice || "auto",
      rate: config.rate || "+0%",
      pitch: config.pitch || "+0Hz",
      volume: config.volume || "+0%",
      // MiMo uses this as a natural-language style instruction; edge ignores it.
      style: config.style || "",
    };
    const urls = urlList();
    const errors = [];
    for (const url of urls) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: timedSignal(config.timeoutMs, signal),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          errors.push(new Error(`${url} HTTP ${response.status}: ${detail.slice(0, 200)}`));
          continue;
        }
        const audio = new Uint8Array(await response.arrayBuffer());
        if (audio.byteLength === 0) {
          errors.push(new Error(`${url} returned no audio bytes`));
          continue;
        }
        return {
          audio,
          mime: response.headers.get("content-type") || "audio/mpeg",
          url,
          provider: response.headers.get("x-tts-provider") || undefined,
        };
      } catch (error) {
        errors.push(new Error(`${url}: ${describeError(error)}`));
      }
    }
    throw new AggregateError(errors, `all TTS endpoints failed: ${errors.map((e) => e.message).join("; ")}`);
  }

  async function play(audio, mime = "audio/mpeg") {
    if (disposed) throw new Error("speech service is disposed");
    if (!cacheDir) throw new Error("TTS cache directory is required");
    await mkdir(cacheDir, { recursive: true });
    // afplay selects its parser from the file extension. MiMo/Qwen return
    // WAV even though the generic TTS contract used to save everything as
    // .mp3, which made afplay fail with "AudioFileOpen failed".
    const type = String(mime || "").toLowerCase();
    const extension = type.includes("wav") ? "wav"
      : type.includes("ogg") ? "ogg"
        : type.includes("aac") || type.includes("mp4") ? "m4a"
          : type.includes("flac") ? "flac"
            : "mp3";
    const file = join(cacheDir, `tts-${Date.now()}-${randomUUID()}.${extension}`);
    await writeFile(file, Buffer.from(audio));
    stop();
    const { command, args } = playerCommand(config.player, platform);
    let child;
    try {
      child = spawnImpl(command, args(file), { stdio: "ignore" });
    } catch (error) {
      await rm(file, { force: true });
      throw new Error(`failed to start ${command}: ${describeError(error)}`);
    }
    const info = { child, stopped: false };
    current = info;
    try {
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          // A deliberate stop (new reply, dispose) is not a playback failure.
          if (info.stopped || code === 0) resolve();
          else reject(new Error(`${command} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`));
        });
      });
    } finally {
      if (current === info) current = null;
      await rm(file, { force: true }).catch(() => {});
    }
    return { bytes: audio.byteLength ?? audio.length, mime, player: command };
  }

  function stop() {
    if (!current) return;
    const info = current;
    current = null;
    info.stopped = true;
    try {
      info.child.kill("SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }

  async function speakSpoken(spoken, { voice = undefined } = {}) {
    const result = await synthesize(spoken, { voice });
    if (disposed) throw new Error("speech service is disposed");
    const played = await play(result.audio, result.mime);
    return {
      chars: spoken.length,
      bytes: result.audio.byteLength,
      mime: result.mime,
      provider: result.provider,
      url: result.url,
      player: played.player,
      text: spoken,
    };
  }

  /** Manual playback: reads up to tts.maxChars. */
  async function speak(text, { voice = undefined, maxChars = undefined } = {}) {
    const spoken = toSpeechText(text, maxChars ?? config.maxChars ?? 400);
    if (spoken === "") throw new Error("the text contains nothing speakable");
    return speakSpoken(spoken, { voice });
  }

  /**
   * Automatic playback: "first-sentences" reads the opening sentence(s) within
   * autoSpeakMaxChars, "full" caps the whole reply, "short-only" skips replies
   * that do not fit, and "off" disables auto speech. A skipped reply returns
   * null and makes no network request.
   */
  async function autoSpeak(text, { voice = undefined } = {}) {
    const mode = typeof config.autoSpeakMode === "string" ? config.autoSpeakMode : "first-sentences";
    if (mode === "off") return null;
    const maxChars = Number(config.autoSpeakMaxChars) || 120;
    let spoken = "";
    if (mode === "short-only") {
      const full = toSpeechText(text, 100_000);
      if (full === "" || full.length > maxChars) return null;
      spoken = full;
    } else if (mode === "full") {
      spoken = toSpeechText(text, maxChars);
    } else {
      spoken = toAutoSpeechText(text, maxChars);
    }
    if (spoken === "") return null;
    return speakSpoken(spoken, { voice });
  }

  function dispose() {
    disposed = true;
    stop();
  }

  return {
    synthesize,
    speak,
    autoSpeak,
    play,
    stop,
    dispose,
    urls: urlList,
    get playing() {
      return current !== null;
    },
  };
}
