#!/usr/bin/env node
/**
 * Qwen3-TTS-Flash local HTTP service.
 *
 * Reuses ~/.dsh/companion/dashscope.env (the ASR key is the same Model Studio
 * key). Contract: GET /health, GET /voices, POST /tts {text, voice, style}.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const ENV_FILE = process.env.QWEN_TTS_ENV || join(HOME, "companion", "dashscope.env");
const PORT = Number(process.env.QWEN_TTS_PORT || 9006);
const MODEL = process.env.QWEN_TTS_MODEL || "qwen3-tts-flash";
const DEFAULT_BASE = "https://dashscope.aliyuncs.com/api/v1";
const MAX_BODY = 1024 * 1024;

function loadEnv(file) {
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const value = match[2].replace(/^['"]|['"]$/g, "");
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  } catch {}
}
loadEnv(ENV_FILE);

const API_KEY = process.env.DASHSCOPE_API_KEY || "";
const BASE = (process.env.QWEN_TTS_BASE_URL
  || process.env.DASHSCOPE_BASE_URL
  || DEFAULT_BASE).replace(/\/+$/, "");
const FALLBACK_BASE = DEFAULT_BASE;
const VOICES = [
  { id: "Cherry", label: "Cherry（女声）", language: "zh" },
  { id: "Ethan", label: "Ethan（男声）", language: "zh" },
  { id: "Li", label: "Li（女声）", language: "zh" },
  { id: "Sunny", label: "Sunny（女声）", language: "zh" },
  { id: "Kiki", label: "Kiki（女声）", language: "zh" },
  { id: "Marcus", label: "Marcus（男声）", language: "zh" },
  { id: "Roy", label: "Roy（男声）", language: "zh" },
  { id: "Peter", label: "Peter（男声）", language: "zh" },
];

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

async function synthesize(text, voice) {
  const errors = [];
  for (const base of [...new Set([BASE, FALLBACK_BASE])]) {
    try {
      const response = await fetch(`${base}/services/aigc/multimodal-generation/generation`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          input: { text, voice: voice || "Cherry", language_type: "Chinese" },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const raw = await response.text();
      if (!response.ok) {
        errors.push(`${base}: HTTP ${response.status}: ${raw.slice(0, 240)}`);
        continue;
      }
      const data = JSON.parse(raw);
      const audio = data?.output?.audio;
      if (!audio) {
        errors.push(`${base}: no output.audio: ${raw.slice(0, 240)}`);
        continue;
      }
      if (audio.data) {
        return { audio: Buffer.from(audio.data, "base64"), mime: "audio/wav" };
      }
      if (audio.url) {
        const download = await fetch(audio.url, { signal: AbortSignal.timeout(60_000) });
        if (!download.ok) throw new Error(`audio download HTTP ${download.status}`);
        const mime = audio.url.toLowerCase().includes(".mp3") ? "audio/mpeg" : "audio/wav";
        return { audio: Buffer.from(await download.arrayBuffer()), mime };
      }
      errors.push(`${base}: audio has neither data nor url`);
    } catch (error) {
      errors.push(`${base}: ${error.message || error}`);
    }
  }
  throw new Error(errors.join("; ") || "Qwen TTS failed");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "qwen-tts",
      provider: "qwen",
      configured: Boolean(API_KEY),
      model: MODEL,
      baseUrl: BASE,
      voices: VOICES.length,
    });
  }
  if (req.method === "GET" && url.pathname === "/voices") {
    return json(res, 200, { ok: true, voices: VOICES });
  }
  if (req.method !== "POST" || url.pathname !== "/tts") {
    return json(res, 404, { ok: false, error: "not found" });
  }
  if (!API_KEY) return json(res, 503, { ok: false, error: "DASHSCOPE_API_KEY missing" });
  try {
    const body = await readBody(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json(res, 400, { ok: false, error: "text is required" });
    const voice = body.voice === "auto" || !body.voice ? "Cherry" : String(body.voice);
    const result = await synthesize(text, voice);
    res.writeHead(200, {
      "content-type": result.mime,
      "content-length": result.audio.length,
      "x-tts-provider": "qwen",
    });
    res.end(result.audio);
  } catch (error) {
    json(res, 502, { ok: false, error: error.message || String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[qwen-tts] listening on 127.0.0.1:${PORT} (${API_KEY ? "configured" : "no key"})`);
});
