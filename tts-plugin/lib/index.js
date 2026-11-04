/**
 * companion-tts: TTS provider router + local sidecars.
 *
 * Routes:
 *   POST /companion/tts                 -> audio
 *   GET  /companion/voices              -> voice list
 *   GET  /companion/tts/providers       -> TTS order/enabled
 *   POST /companion/tts/providers       -> change order/enabled
 *   GET  /companion/tts/health          -> provider key/health
 *   GET  /companion/tts/services        -> local sidecar status
 *   POST /companion/tts/services/restart
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHttpTtsAdapter,
  createTtsRouter,
} from "../../adapters/src/index.js";
import { createServiceManager } from "../../voice-runtime/service-manager.js";

export const name = "companion-tts";
export const inject = ["webServer"];

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TTS_TIMEOUT_MS = 60_000;
const VOICES_TIMEOUT_MS = 15_000;
const DEFAULT_PROVIDERS = [
  { name: "mimo", url: "http://127.0.0.1:9004/tts", enabled: true },
  { name: "qwen", url: "http://127.0.0.1:9006/tts", enabled: true },
  { name: "minimax", url: "http://127.0.0.1:9007/tts", enabled: true },
  { name: "edge", url: "http://127.0.0.1:9003/tts", enabled: true },
];

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function describeError(error) {
  if (error instanceof AggregateError) {
    return error.errors.map((entry) => entry?.message ?? String(entry)).join("; ") || error.message;
  }
  return error?.message ?? String(error);
}

function validProvider(value) {
  return value
    && typeof value === "object"
    && typeof value.name === "string" && value.name !== ""
    && typeof value.url === "string" && value.url !== "";
}

function loadConfig(file, legacyFile) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      providers: Array.isArray(raw?.providers) ? raw.providers.filter(validProvider) : undefined,
      source: "file",
      error: null,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { providers: DEFAULT_PROVIDERS, source: "fallback", error: `failed to read ${file}: ${error.message}` };
    }
    try {
      const legacy = JSON.parse(readFileSync(legacyFile, "utf8"));
      if (Array.isArray(legacy?.tts)) {
        return { providers: legacy.tts.filter(validProvider), source: "migrated", error: null };
      }
    } catch {}
    return { providers: DEFAULT_PROVIDERS, source: "default", error: null };
  }
}

function writeConfig(file, providers) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify({ providers }, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(body.length));
  res.end(body);
}

function sendAudio(res, result) {
  res.statusCode = 200;
  res.setHeader("content-type", result.mime);
  res.setHeader("content-length", String(result.audio.byteLength));
  res.setHeader("x-tts-provider", result.provider);
  if (result.cached) res.setHeader("x-tts-cached", "1");
  res.end(Buffer.from(result.audio));
}

function methodIs(req, expected) {
  const method = req.method;
  if (typeof method !== "string" || method === "") return true;
  return method.toUpperCase() === expected;
}

function buildRuntime(providers, fallbackLoggedAt) {
  const configured = providers.filter(validProvider);
  const enabled = configured.filter((provider) => provider.enabled !== false);
  const adapters = enabled.map((provider) => createHttpTtsAdapter(provider));
  const tts = adapters.length > 0
    ? createTtsRouter({
      providers: adapters,
      onFallback: ({ to, errors }) => {
        const names = errors.map((entry) => entry.provider).join(", ");
        const key = `${names}->${to}`;
        const now = Date.now();
        if (now - (fallbackLoggedAt.get(key) ?? 0) < 5 * 60_000) return;
        fallbackLoggedAt.set(key, now);
        console.warn(`[companion-tts] fallback ${names} -> ${to}`);
      },
    })
    : null;
  return { configured, adapters, tts };
}

function providerSnapshot(runtime, loaded) {
  return {
    tts: runtime.configured.map((provider) => ({
      name: provider.name,
      url: provider.url,
      enabled: provider.enabled !== false,
    })),
    source: loaded.source,
    configError: loaded.error,
  };
}

function mergeProviderUpdate(current, body) {
  if (!Array.isArray(body.tts)) return { error: "tts array is required" };
  const byName = new Map(current.map((provider) => [provider.name, provider]));
  const ordered = [];
  for (const item of body.tts) {
    const name = typeof item === "string" ? item : item?.name;
    if (typeof name !== "string") continue;
    const provider = byName.get(name);
    if (!provider) continue;
    const enabled = typeof item === "object" && typeof item.enabled === "boolean"
      ? item.enabled
      : true;
    ordered.push({ ...provider, enabled });
    byName.delete(name);
  }
  for (const provider of byName.values()) ordered.push(provider);
  return { providers: ordered };
}

export function apply(ctx) {
  const root = new URL("../../tts/", import.meta.url);
  const specs = [
    {
      name: "edge",
      cwd: fileURLToPath(new URL("edge-tts/", root)),
      command: "bash",
      args: [fileURLToPath(new URL("edge-tts/run.sh", root))],
      healthUrl: "http://127.0.0.1:9003/health",
    },
    {
      name: "mimo",
      cwd: fileURLToPath(new URL("mimo-tts/", root)),
      command: process.execPath,
      args: [fileURLToPath(new URL("mimo-tts/server.js", root))],
      healthUrl: "http://127.0.0.1:9004/health",
    },
    {
      name: "qwen",
      cwd: fileURLToPath(new URL("qwen-tts/", root)),
      command: process.execPath,
      args: [fileURLToPath(new URL("qwen-tts/server.js", root))],
      healthUrl: "http://127.0.0.1:9006/health",
    },
    {
      name: "minimax",
      cwd: fileURLToPath(new URL("minimax-tts/", root)),
      command: process.execPath,
      args: [fileURLToPath(new URL("minimax-tts/server.js", root))],
      healthUrl: "http://127.0.0.1:9007/health",
    },
  ];
  const manager = createServiceManager(specs);
  const configFile = join(homeDir(), "companion", "tts.json");
  const legacyFile = join(homeDir(), "companion", "adapters.json");
  const fallbackLoggedAt = new Map();
  let loaded = loadConfig(configFile, legacyFile);
  let runtime = buildRuntime(loaded.providers, fallbackLoggedAt);
  if (loaded.source === "migrated") writeConfig(configFile, loaded.providers);
  if (loaded.error) console.warn(`[companion-tts] ${loaded.error}`);
  void manager.ensureAll();

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/tts",
    handler: async (req, res) => {
      if (!methodIs(req, "POST")) return sendJson(res, 405, { ok: false, error: "use POST" });
      if (!runtime.tts) return sendJson(res, 503, { ok: false, error: "no TTS provider enabled" });
      try {
        const body = await readJson(req);
        if (typeof body.text !== "string" || body.text.trim() === "") {
          return sendJson(res, 400, { ok: false, error: "text is required" });
        }
        const result = await runtime.tts.synthesize(body, { signal: AbortSignal.timeout(TTS_TIMEOUT_MS) });
        sendAudio(res, result);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: describeError(error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/voices",
    handler: async (req, res) => {
      if (!methodIs(req, "GET")) return sendJson(res, 405, { ok: false, error: "use GET" });
      const enabled = runtime.configured.filter((provider) => provider.enabled !== false);
      if (!enabled.length) return sendJson(res, 503, { ok: false, error: "no TTS provider enabled" });
      try {
        const url = new URL(req.url ?? "/companion/voices", "http://127.0.0.1");
        const locale = url.searchParams.get("locale");
        const errors = [];
        for (const provider of enabled) {
          try {
            const base = provider.url.replace(/\/tts\/?$/, "");
            const target = new URL(`${base}/voices`);
            if (locale) target.searchParams.set("locale", locale);
            const response = await fetch(target, { signal: AbortSignal.timeout(VOICES_TIMEOUT_MS) });
            if (!response.ok) {
              const detail = await response.text().catch(() => "");
              errors.push(`${provider.name}: HTTP ${response.status}: ${detail.slice(0, 120)}`);
              continue;
            }
            return sendJson(res, 200, await response.json());
          } catch (error) {
            errors.push(`${provider.name}: ${describeError(error)}`);
          }
        }
        return sendJson(res, 502, { ok: false, error: `no provider returned voices: ${errors.join("; ")}` });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: describeError(error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/tts/providers",
    handler: async (req, res) => {
      if (methodIs(req, "GET")) return sendJson(res, 200, { ok: true, ...providerSnapshot(runtime, loaded) });
      if (!methodIs(req, "POST")) return sendJson(res, 405, { ok: false, error: "use GET or POST" });
      try {
        const body = await readJson(req);
        const merged = mergeProviderUpdate(runtime.configured, body);
        if (merged.error) return sendJson(res, 400, { ok: false, error: merged.error });
        writeConfig(configFile, merged.providers);
        loaded = { providers: merged.providers, source: "file", error: null };
        runtime = buildRuntime(loaded.providers, fallbackLoggedAt);
        return sendJson(res, 200, { ok: true, ...providerSnapshot(runtime, loaded) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: describeError(error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/tts/health",
    handler: async (req, res) => {
      if (!methodIs(req, "GET")) return sendJson(res, 405, { ok: false, error: "use GET" });
      const providers = await Promise.all(runtime.configured.map(async (provider) => {
        const base = provider.url.replace(/\/tts\/?$/, "");
        try {
          const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_500) });
          const body = await response.json().catch(() => null);
          const configured = typeof body?.configured === "boolean"
            ? body.configured
            : typeof body?.keyConfigured === "boolean"
              ? body.keyConfigured
              : null;
          return {
            name: provider.name,
            enabled: provider.enabled !== false,
            ok: response.ok && body?.ok !== false,
            configured,
            error: response.ok ? null : `HTTP ${response.status}`,
          };
        } catch (error) {
          return { name: provider.name, enabled: provider.enabled !== false, ok: false, configured: null, error: describeError(error) };
        }
      }));
      return sendJson(res, 200, { ok: true, providers, services: manager.snapshot() });
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/tts/services",
    handler: async (req, res) => {
      if (!methodIs(req, "GET")) return sendJson(res, 405, { ok: false, error: "use GET" });
      return sendJson(res, 200, { ok: true, services: manager.snapshot() });
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/tts/services/restart",
    handler: async (req, res) => {
      if (!methodIs(req, "POST")) return sendJson(res, 405, { ok: false, error: "use POST" });
      let body = {};
      try { body = await readJson(req); } catch {}
      const name = typeof body.name === "string" ? body.name : null;
      try {
        return sendJson(res, 200, { ok: true, services: await manager.restart(name) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: describeError(error) });
      }
    },
  }));
}
