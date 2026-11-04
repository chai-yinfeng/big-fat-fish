#!/usr/bin/env node
/**
 * MiniMax T2A local HTTP service.
 * Reads ~/.dsh/companion/minimax.env (MINIMAX_API_KEY, optional MINIMAX_GROUP_ID).
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const ENV_FILE = process.env.MINIMAX_ENV || join(HOME, "companion", "minimax.env");
const PORT = Number(process.env.MINIMAX_TTS_PORT || 9007);
const MODEL = process.env.MINIMAX_TTS_MODEL || "speech-2.8-hd";
const BASE = (process.env.MINIMAX_API_BASE || "https://api.minimaxi.com/v1").replace(/\/+$/, "");
const BASE_CANDIDATES = [...new Set([
  BASE,
  "https://api.minimaxi.com/v1",
  "https://api.minimax.io/v1",
  "https://api.minimax.chat/v1",
])];
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

const API_KEY = process.env.MINIMAX_API_KEY || "";
const GROUP_ID = process.env.MINIMAX_GROUP_ID || "";
const VOICES = [
  { id: "female-shaonv", label: "少女（女声）", language: "zh" },
  { id: "female-yujie", label: "御姐（女声）", language: "zh" },
  { id: "female-chengshu", label: "成熟女声", language: "zh" },
  { id: "male-qn-qingse", label: "青涩青年（男声）", language: "zh" },
  { id: "male-qn-jingying", label: "精英青年（男声）", language: "zh" },
  { id: "male-qn-badao", label: "霸道青年（男声）", language: "zh" },
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "minimax-tts",
      provider: "minimax",
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
  if (!API_KEY) return json(res, 503, { ok: false, error: "MINIMAX_API_KEY missing" });
  try {
    const body = await readBody(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return json(res, 400, { ok: false, error: "text is required" });
    const voice = body.voice === "auto" || !body.voice ? "female-shaonv" : String(body.voice);
    const errors = [];
    for (const base of BASE_CANDIDATES) {
      try {
        const endpoint = new URL(`${base}/t2a_v2`);
        if (GROUP_ID) endpoint.searchParams.set("GroupId", GROUP_ID);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: MODEL,
            text,
            stream: false,
            voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
            audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
            language_boost: "Chinese",
            output_format: "hex",
          }),
          signal: AbortSignal.timeout(90_000),
        });
        const raw = await response.text();
        if (!response.ok) {
          errors.push(`${base}: HTTP ${response.status}: ${raw.slice(0, 200)}`);
          continue;
        }
        const data = JSON.parse(raw);
        const hex = data?.data?.audio;
        if (!hex) {
          errors.push(`${base}: ${raw.slice(0, 200)}`);
          continue;
        }
        const audio = Buffer.from(hex, "hex");
        res.writeHead(200, {
          "content-type": "audio/mpeg",
          "content-length": audio.length,
          "x-tts-provider": "minimax",
        });
        res.end(audio);
        return;
      } catch (error) {
        errors.push(`${base}: ${error.message || error}`);
      }
    }
    json(res, 502, { ok: false, error: `MiniMax failed: ${errors.join("; ")}` });
  } catch (error) {
    json(res, 502, { ok: false, error: error.message || String(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[minimax-tts] listening on 127.0.0.1:${PORT} (${API_KEY ? "configured" : "no key"})`);
});
