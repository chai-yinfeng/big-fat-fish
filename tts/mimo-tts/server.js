#!/usr/bin/env node
/**
 * Standalone MiMo-V2.5-TTS HTTP service.
 *
 * MiMo's TTS endpoint is OpenAI-compatible:
 *   POST {baseUrl}/chat/completions
 *   { model, messages, audio: { format: "wav", voice } }
 * The audio comes back as base64 inside choices[0].message.audio.data.
 *
 * This service keeps the API key out of DSH: it reads MIMO_API_KEY from the
 * environment, or from $DSH_HOME/companion/mimo.env (KEY=VALUE lines).
 *
 *   POST /tts    { text, voice?, style?, format? } -> audio/wav
 *   GET  /voices -> preset MiMo voices
 *   GET  /health -> { ok, model, keyConfigured, voice }
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 9004;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MODEL = "mimo-v2.5-tts";
const DEFAULT_VOICE = "冰糖";
const DEFAULT_STYLE = "温柔、自然，像在跟亲近的人说话，语速稍慢，不要播音腔。";
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_TEXT_CHARS = 4000;
const MAX_STYLE_CHARS = 1000;
const DEFAULT_TIMEOUT_MS = 90_000;

export const MIMO_VOICES = [
  { shortName: "冰糖", locale: "zh-CN", localeName: "Chinese (Mandarin, Simplified)", gender: "Female", friendlyName: "MiMo 冰糖（中文女声，温和）" },
  { shortName: "茉莉", locale: "zh-CN", localeName: "Chinese (Mandarin, Simplified)", gender: "Female", friendlyName: "MiMo 茉莉（中文女声）" },
  { shortName: "苏打", locale: "zh-CN", localeName: "Chinese (Mandarin, Simplified)", gender: "Male", friendlyName: "MiMo 苏打（中文男声）" },
  { shortName: "白桦", locale: "zh-CN", localeName: "Chinese (Mandarin, Simplified)", gender: "Male", friendlyName: "MiMo 白桦（中文男声）" },
  { shortName: "Mia", locale: "en-US", localeName: "English (United States)", gender: "Female", friendlyName: "MiMo Mia (English, female)" },
  { shortName: "Chloe", locale: "en-US", localeName: "English (United States)", gender: "Female", friendlyName: "MiMo Chloe (English, female)" },
  { shortName: "Milo", locale: "en-US", localeName: "English (United States)", gender: "Male", friendlyName: "MiMo Milo (English, male)" },
  { shortName: "Dean", locale: "en-US", localeName: "English (United States)", gender: "Male", friendlyName: "MiMo Dean (English, male)" },
];

const KNOWN_VOICES = new Set([...MIMO_VOICES.map((voice) => voice.shortName), "mimo_default"]);

export class MimoBadRequest extends Error {}

export class MimoApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function describeError(error) {
  return error?.message ?? String(error);
}

function loadEnvFile(file) {
  if (!file) return;
  try {
    const source = readFileSync(file, "utf8");
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[mimo-tts] failed to read ${file}: ${describeError(error)}`);
    }
  }
}

export function resolveConfig(options = {}) {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const envFile = options.envFile === false
    ? false
    : options.envFile ?? join(home, "companion", "mimo.env");
  if (envFile) loadEnvFile(envFile);
  return {
    apiKey: options.apiKey ?? process.env.MIMO_API_KEY ?? "",
    baseUrl: (options.baseUrl ?? process.env.MIMO_BASE_URL ?? "https://api.xiaomimimo.com/v1").replace(/\/+$/, ""),
    model: options.model ?? process.env.MIMO_MODEL ?? DEFAULT_MODEL,
    voice: options.voice ?? process.env.MIMO_VOICE ?? DEFAULT_VOICE,
    style: options.style ?? process.env.MIMO_STYLE ?? DEFAULT_STYLE,
    timeoutMs: Math.max(5_000, Number(options.timeoutMs ?? process.env.MIMO_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    envFile,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new MimoBadRequest(`request body is too large (max ${MAX_BODY_BYTES} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new MimoBadRequest("JSON body must be an object"));
        }
        resolve(parsed);
      } catch (error) {
        reject(new MimoBadRequest(`invalid JSON body: ${describeError(error)}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

function validVoice(requested, config) {
  const value = requested === undefined || requested === null || requested === "" || requested === "auto"
    ? config.voice
    : String(requested).trim();
  if (!KNOWN_VOICES.has(value)) {
    throw new MimoBadRequest(
      `unknown MiMo voice "${value}"; use auto, mimo_default, or one of: ${MIMO_VOICES.map((voice) => voice.shortName).join(", ")}`,
    );
  }
  return value;
}

function validStyle(requested, config) {
  const value = requested === undefined || requested === null ? config.style : String(requested).trim();
  if (value.length > MAX_STYLE_CHARS) {
    throw new MimoBadRequest(`style is too long (max ${MAX_STYLE_CHARS} characters)`);
  }
  return value;
}

export async function synthesizeMimo({ text, voice, style, format = "wav" } = {}, config) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new MimoBadRequest("text must be a non-empty string");
  }
  const normalizedText = text.trim();
  if (normalizedText.length > MAX_TEXT_CHARS) {
    throw new MimoBadRequest(`text is too long (max ${MAX_TEXT_CHARS} characters)`);
  }
  if (format !== "wav" && format !== "pcm16") {
    throw new MimoBadRequest('format must be "wav" or "pcm16"');
  }
  if (!config.apiKey) {
    throw new MimoApiError(401, "MIMO_API_KEY is not set; put it in the environment or $DSH_HOME/companion/mimo.env");
  }
  const selectedVoice = validVoice(voice, config);
  const selectedStyle = validStyle(style, config);
  const messages = [];
  if (selectedStyle) messages.push({ role: "user", content: selectedStyle });
  messages.push({ role: "assistant", content: normalizedText });
  const body = {
    model: config.model,
    messages,
    audio: { format, voice: selectedVoice },
  };
  let response;
  try {
    response = await config.fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    throw new MimoApiError(502, `MiMo request failed: ${describeError(error)}`);
  }
  const raw = await response.text();
  if (!response.ok) {
    const detail = raw.slice(0, 300);
    if (response.status === 401 || response.status === 403) {
      throw new MimoApiError(502, `MiMo API key rejected (HTTP ${response.status}): ${detail}`);
    }
    throw new MimoApiError(502, `MiMo HTTP ${response.status}: ${detail}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new MimoApiError(502, `MiMo returned non-JSON: ${describeError(error)}`);
  }
  const data = payload?.choices?.[0]?.message?.audio?.data;
  if (typeof data !== "string" || data === "") {
    throw new MimoApiError(502, "MiMo response contained no choices[0].message.audio.data");
  }
  const audio = Buffer.from(data, "base64");
  if (audio.length === 0) throw new MimoApiError(502, "MiMo returned empty audio");
  return {
    audio,
    mime: format === "pcm16" ? "audio/pcm" : "audio/wav",
    voice: selectedVoice,
    model: config.model,
    format,
  };
}

export function createMimoServer(options = {}) {
  const config = resolveConfig(options);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          service: "mimo-tts",
          model: config.model,
          keyConfigured: Boolean(config.apiKey),
          voice: config.voice,
          baseUrl: config.baseUrl,
          envFile: config.envFile || null,
        });
      }
      if (req.method === "GET" && url.pathname === "/voices") {
        const locale = (url.searchParams.get("locale") ?? "").toLowerCase();
        const voices = locale
          ? MIMO_VOICES.filter((voice) => voice.locale.toLowerCase().startsWith(locale))
          : MIMO_VOICES;
        return sendJson(res, 200, { ok: true, count: voices.length, voices });
      }
      if (req.method === "POST" && url.pathname === "/tts") {
        const body = await readJsonBody(req);
        const result = await synthesizeMimo({
          text: body.text,
          voice: body.voice,
          style: body.style,
          format: body.format,
        }, config);
        res.writeHead(200, {
          "content-type": result.mime,
          "content-length": String(result.audio.length),
          "x-tts-provider": "mimo",
          "x-voice": encodeURIComponent(result.voice),
          "cache-control": "no-store",
        });
        return res.end(result.audio);
      }
      return sendJson(res, 404, { ok: false, error: "not found; use GET /health, GET /voices or POST /tts" });
    } catch (error) {
      if (error instanceof MimoBadRequest) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
      if (error instanceof MimoApiError) {
        // A missing key is a configuration state, not a per-request incident.
        if (error.status !== 401) console.warn(`[mimo-tts] ${error.message}`);
        return sendJson(res, error.status === 401 ? 503 : 502, { ok: false, error: error.message });
      }
      console.warn(`[mimo-tts] ${describeError(error)}`);
      return sendJson(res, 500, { ok: false, error: describeError(error) });
    }
  });
  return { server, config };
}

function parseArgs(argv) {
  const args = { host: DEFAULT_HOST, port: DEFAULT_PORT, envFile: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    else if (arg === "--port") args.port = Number(argv[++index]);
    else if (arg === "--env-file") args.envFile = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node server.js [--host 127.0.0.1] [--port 9004] [--env-file path]");
      process.exit(0);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  const { server, config } = createMimoServer({ envFile: args.envFile });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : args.port;
  console.log(`MIMO_TTS_PORT=${port}`);
  console.log(`MIMO_TTS_URL=http://${args.host}:${port}`);
  console.error(
    `[mimo-tts] listening on http://${args.host}:${port} (model ${config.model}, voice ${config.voice}, key ${config.apiKey ? "configured" : "missing"})`,
  );
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { server, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[mimo-tts] failed to start: ${describeError(error)}`);
    process.exit(1);
  });
}
