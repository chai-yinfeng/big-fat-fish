/**
 * companion-asr: ASR gateway proxy + local gateway/model sidecar.
 *
 * Routes:
 *   POST /companion/asr                  -> gateway /asr
 *   GET  /companion/asr/providers        -> ordered providers
 *   POST /companion/asr/providers
 *   GET  /companion/asr/models           -> gateway model status
 *   POST /companion/asr/models/install   -> { target }
 *   GET  /companion/asr/health           -> gateway health + sidecar
 *   GET  /companion/asr/services
 *   POST /companion/asr/services/restart
 *
 * Streaming stays direct at ws://127.0.0.1:9005/asr/stream, so the UI keeps
 * low-latency partials without a second proxy hop.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceManager } from "../../voice-runtime/service-manager.js";

export const name = "companion-asr";
export const inject = ["webServer"];

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const ASR_PROVIDER_NAMES = new Set(["qwen3", "sensevoice", "zipformer"]);
const DEFAULT_PROVIDERS = [
  { name: "zipformer", enabled: true },
  { name: "qwen3", enabled: true },
  { name: "sensevoice", enabled: true },
];
const DEFAULT_URL = "http://127.0.0.1:9005/asr";

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function describeError(error) {
  return error?.message ?? String(error);
}

function normalizeProviders(raw) {
  const source = Array.isArray(raw) ? raw : DEFAULT_PROVIDERS;
  const seen = new Set();
  const providers = [];
  for (const entry of source) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (typeof name !== "string" || !ASR_PROVIDER_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name);
    providers.push({
      name,
      enabled: typeof entry === "object" && typeof entry.enabled === "boolean" ? entry.enabled : true,
    });
  }
  return providers.length ? providers : DEFAULT_PROVIDERS.map((entry) => ({ ...entry }));
}

function loadConfig(file, legacyFile) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      url: typeof raw?.url === "string" && raw.url ? raw.url : DEFAULT_URL,
      provider: typeof raw?.provider === "string" ? raw.provider : "auto",
      providers: normalizeProviders(raw?.providers),
      source: "file",
      error: null,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { url: DEFAULT_URL, provider: "auto", providers: DEFAULT_PROVIDERS, source: "fallback", error: `failed to read ${file}: ${error.message}` };
    }
    try {
      const legacy = JSON.parse(readFileSync(legacyFile, "utf8"));
      if (legacy?.asr && typeof legacy.asr === "object") {
        return {
          url: typeof legacy.asr.url === "string" ? legacy.asr.url : DEFAULT_URL,
          provider: typeof legacy.asr.provider === "string" ? legacy.asr.provider : "auto",
          providers: normalizeProviders(legacy.asr.providers),
          source: "migrated",
          error: null,
        };
      }
    } catch {}
    return { url: DEFAULT_URL, provider: "auto", providers: DEFAULT_PROVIDERS, source: "default", error: null };
  }
}

function writeConfig(file, config) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

function methodIs(req, expected) {
  const method = req.method;
  if (typeof method !== "string" || method === "") return true;
  return method.toUpperCase() === expected;
}

function snapshot(config) {
  return {
    asr: {
      url: config.url,
      enabled: Boolean(config.url),
      provider: config.provider || "auto",
      providers: config.providers,
    },
    source: config.source,
    configError: config.error,
  };
}

function mergeProviders(current, body) {
  if (!Array.isArray(body.providers)) return { error: "providers array is required" };
  const byName = new Map(current.map((provider) => [provider.name, provider]));
  const ordered = [];
  for (const item of body.providers) {
    const name = typeof item === "string" ? item : item?.name;
    if (typeof name !== "string" || !ASR_PROVIDER_NAMES.has(name)) {
      return { error: "providers may only contain zipformer, qwen3 and sensevoice" };
    }
    const provider = byName.get(name);
    const enabled = typeof item === "object" && typeof item.enabled === "boolean"
      ? item.enabled
      : true;
    ordered.push(provider ? { ...provider, enabled } : { name, enabled });
    byName.delete(name);
  }
  for (const provider of byName.values()) ordered.push(provider);
  return { providers: ordered };
}

export function apply(ctx) {
  const root = new URL("../../asr/", import.meta.url);
  const manager = createServiceManager([{
    name: "asr",
    cwd: fileURLToPath(root),
    command: "bash",
    args: [fileURLToPath(new URL("run.sh", root))],
    healthUrl: "http://127.0.0.1:9005/health",
  }]);
  const configFile = join(homeDir(), "companion", "asr.json");
  const legacyFile = join(homeDir(), "companion", "adapters.json");
  let config = loadConfig(configFile, legacyFile);
  if (config.source === "migrated") writeConfig(configFile, {
    url: config.url,
    provider: config.provider,
    providers: config.providers,
  });
  if (config.error) console.warn(`[companion-asr] ${config.error}`);
  void manager.ensureAll();

  function baseUrl() {
    return config.url.replace(/\/asr\/?$/, "");
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/asr",
    handler: async (req, res) => {
      if (!methodIs(req, "POST")) return sendJson(res, 405, { ok: false, error: "use POST" });
      try {
        const body = await readJson(req);
        if (typeof body.audio !== "string" || body.audio === "") {
          return sendJson(res, 400, { ok: false, error: "audio is required" });
        }
        const enabled = config.providers.filter((provider) => provider.enabled !== false).map((provider) => provider.name);
        if (!enabled.length) return sendJson(res, 503, { ok: false, error: "no ASR provider enabled" });
        const payload = body.providers === undefined
          ? { ...body, providers: enabled, ...(config.provider ? { provider: config.provider } : {}) }
          : body;
        const response = await fetch(config.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(90_000),
        });
        const text = await response.text();
        res.statusCode = response.status;
        res.setHeader("content-type", response.headers.get("content-type") || "application/json; charset=utf-8");
        res.setHeader("content-length", String(Buffer.byteLength(text)));
        res.end(text);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: describeError(error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/asr/providers",
    handler: async (req, res) => {
      if (methodIs(req, "GET")) return sendJson(res, 200, { ok: true, ...snapshot(config) });
      if (!methodIs(req, "POST")) return sendJson(res, 405, { ok: false, error: "use GET or POST" });
      try {
        const body = await readJson(req);
        const merged = mergeProviders(config.providers, body);
        if (merged.error) return sendJson(res, 400, { ok: false, error: merged.error });
        config = {
          ...config,
          providers: merged.providers,
          source: "file",
          error: null,
        };
        writeConfig(configFile, {
          url: config.url,
          provider: config.provider,
          providers: config.providers,
        });
        return sendJson(res, 200, { ok: true, ...snapshot(config) });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: describeError(error) });
      }
    },
  }));

  async function proxyJson(req, res, path, options = {}) {
    try {
      const url = `${baseUrl()}${path}`;
      const init = { method: options.method || req.method, signal: AbortSignal.timeout(90_000) };
      if (init.method === "POST") {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(options.body ?? await readJson(req));
      }
      const response = await fetch(url, init);
      const text = await response.text();
      res.statusCode = response.status;
      res.setHeader("content-type", response.headers.get("content-type") || "application/json; charset=utf-8");
      res.setHeader("content-length", String(Buffer.byteLength(text)));
      res.end(text);
    } catch (error) {
      sendJson(res, 502, { ok: false, error: describeError(error) });
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/asr/models",
    handler: async (req, res) => {
      if (!methodIs(req, "GET")) return sendJson(res, 405, { ok: false, error: "use GET" });
      return proxyJson(req, res, "/models", { method: "GET" });
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/asr/models/install",
    handler: async (req, res) => {
      if (!methodIs(req, "POST")) return sendJson(res, 405, { ok: false, error: "use POST" });
      return proxyJson(req, res, "/models/install", { method: "POST" });
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/asr/health",
    handler: async (req, res) => {
      if (!methodIs(req, "GET")) return sendJson(res, 405, { ok: false, error: "use GET" });
      try {
        const response = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(4_000) });
        const body = await response.json();
        return sendJson(res, response.status, { ...body, services: manager.snapshot() });
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: describeError(error), services: manager.snapshot() });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/asr/services",
    handler: async (req, res) => {
      if (!methodIs(req, "GET")) return sendJson(res, 405, { ok: false, error: "use GET" });
      return sendJson(res, 200, { ok: true, services: manager.snapshot() });
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/asr/services/restart",
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
