/**
 * DSH adapter plugin shell.
 *
 * Exposes local HTTP routes:
 *   POST /companion/tts        -> audio bytes
 *   POST /companion/asr        -> { text }
 *   GET  /companion/voices     -> provider voice list (edge-tts compatible)
 *   GET  /companion/health     -> active provider names
 *   GET  /companion/providers  -> TTS order/enabled + ASR mode
 *   POST /companion/providers  -> change TTS order/enabled + ASR provider mode
 *
 * Providers are plain HTTP endpoints configured in
 * `$DSH_HOME/companion/adapters.json`. This keeps the core independent of any
 * vendor SDK: swap edge-tts / MiMo / MiniMax / a local model by changing URLs.
 *
 * With no config file the plugin uses the standalone edge-tts service at
 * 127.0.0.1:9003, so the default Mac setup works without a config write.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createHttpAsrAdapter,
  createHttpTtsAdapter,
  createTtsRouter,
} from "../../adapters/src/index.js";

export const name = "companion-adapters";
export const inject = ["webServer"];

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TTS_TIMEOUT_MS = 60_000;
const VOICES_TIMEOUT_MS = 15_000;
const ASR_PROVIDERS = new Set(["auto", "local", "cloud"]);
const ASR_PROVIDER_NAMES = new Set(["qwen3", "sensevoice", "zipformer"]);
const DEFAULT_ASR_PROVIDERS = [
  { name: "qwen3", enabled: true },
  { name: "zipformer", enabled: true },
  { name: "sensevoice", enabled: true },
];
export const DEFAULT_EDGE_URL = "http://127.0.0.1:9003/tts";

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

/**
 * Missing file -> default edge provider. A malformed file -> default edge
 * provider plus a recorded error; an explicit empty `tts: []` still means
 * "no TTS provider" and keeps the 503 behavior.
 */
export function loadConfig(file = join(homeDir(), "companion", "adapters.json")) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      config: {
        tts: Array.isArray(raw?.tts) ? raw.tts.filter(validProvider) : undefined,
        asr: validProvider(raw?.asr) ? raw.asr : null,
      },
      source: "file",
      error: null,
      file,
    };
  } catch (error) {
    const missing = error?.code === "ENOENT";
    return {
      config: {
        tts: [{ name: "edge", url: DEFAULT_EDGE_URL }],
        asr: null,
      },
      source: missing ? "default-edge" : "fallback",
      error: missing ? null : `failed to read ${file}: ${error?.message ?? error}`,
      file,
    };
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
  // Direct handler tests (and embedded callers) may omit the method; the DSH
  // web server always supplies one.
  if (typeof method !== "string" || method === "") return true;
  return method.toUpperCase() === expected;
}

function normalizeAsrProviders(asr) {
  const raw = Array.isArray(asr?.providers) ? asr.providers : DEFAULT_ASR_PROVIDERS;
  const seen = new Set();
  const providers = [];
  for (const entry of raw) {
    const name = typeof entry === "string" ? entry : entry?.name;
    if (typeof name !== "string" || !ASR_PROVIDER_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name);
    providers.push({
      name,
      enabled: typeof entry === "object" && typeof entry.enabled === "boolean" ? entry.enabled : true,
    });
  }
  // Unknown/malformed lists still fall back to the default pair.
  return providers.length > 0 ? providers : DEFAULT_ASR_PROVIDERS.map((entry) => ({ ...entry }));
}

function buildRuntime(loaded, fallbackLoggedAt) {
  const configured = (loaded.config.tts ?? []).filter(validProvider);
  const enabled = configured.filter((provider) => provider.enabled !== false);
  const providers = enabled.map((provider) => createHttpTtsAdapter(provider));
  const tts = providers.length > 0
    ? createTtsRouter({
      providers,
      onFallback: ({ to, errors }) => {
        const names = errors.map((entry) => entry.provider).join(", ");
        const key = `${names}->${to}`;
        const now = Date.now();
        if (now - (fallbackLoggedAt.get(key) ?? 0) < 5 * 60_000) return;
        fallbackLoggedAt.set(key, now);
        console.warn(`[companion-adapters] TTS fallback ${names} -> ${to}`);
      },
    })
    : null;
  const asrConfig = loaded.config.asr?.enabled === false ? null : loaded.config.asr;
  const asrProviders = normalizeAsrProviders(asrConfig);
  const asrEnabled = asrProviders.filter((provider) => provider.enabled !== false).map((provider) => provider.name);
  const asr = asrConfig ? createHttpAsrAdapter(asrConfig) : null;
  return { loaded, configured, providers, tts, asr, asrConfig, asrProviders, asrEnabled };
}

function providerSnapshot(runtime) {
  return {
    tts: runtime.configured.map((provider) => ({
      name: provider.name,
      url: provider.url,
      enabled: provider.enabled !== false,
    })),
    asr: runtime.loaded.config.asr
      ? {
        name: runtime.loaded.config.asr.name,
        url: runtime.loaded.config.asr.url,
        enabled: runtime.loaded.config.asr.enabled !== false,
        provider: runtime.loaded.config.asr.provider || "auto",
        providers: runtime.asrProviders,
      }
      : null,
    source: runtime.loaded.source,
    configError: runtime.loaded.error,
  };
}

function mergeProviderUpdate(current, body) {
  const next = {
    ...current,
    tts: Array.isArray(current.tts) ? [...current.tts] : [],
    asr: current.asr && typeof current.asr === "object" ? { ...current.asr } : null,
  };
  if (Array.isArray(body.tts)) {
    const byName = new Map(next.tts.map((provider) => [provider.name, provider]));
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
    next.tts = ordered;
  }
  if (body.asr && typeof body.asr === "object") {
    if (!next.asr) {
      return { error: "no ASR provider is configured" };
    }
    if (typeof body.asr.enabled === "boolean") next.asr.enabled = body.asr.enabled;
    if (typeof body.asr.provider === "string") {
      if (!ASR_PROVIDERS.has(body.asr.provider)) {
        return { error: "asr.provider must be auto, local or cloud" };
      }
      next.asr.provider = body.asr.provider;
    }
    if (Array.isArray(body.asr.providers)) {
      const currentProviders = normalizeAsrProviders(next.asr);
      const byName = new Map(currentProviders.map((provider) => [provider.name, provider]));
      const ordered = [];
      for (const item of body.asr.providers) {
        const name = typeof item === "string" ? item : item?.name;
        if (typeof name !== "string" || !ASR_PROVIDER_NAMES.has(name)) {
          return { error: "asr.providers may only contain qwen3, sensevoice and zipformer" };
        }
        const provider = byName.get(name);
        const enabled = typeof item === "object" && typeof item.enabled === "boolean"
          ? item.enabled
          : true;
        ordered.push(provider ? { ...provider, enabled } : { name, enabled });
        byName.delete(name);
      }
      for (const provider of byName.values()) ordered.push(provider);
      next.asr.providers = ordered;
    }
  }
  return { config: next };
}

export function apply(ctx) {
  const configFile = join(homeDir(), "companion", "adapters.json");
  const fallbackLoggedAt = new Map();
  let loaded = loadConfig(configFile);
  let runtime = buildRuntime(loaded, fallbackLoggedAt);
  if (loaded.error) console.warn(`[companion-adapters] ${loaded.error}`);

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
    path: "/companion/asr",
    handler: async (req, res) => {
      if (!methodIs(req, "POST")) return sendJson(res, 405, { ok: false, error: "use POST" });
      if (!runtime.asr) return sendJson(res, 503, { ok: false, error: "no ASR provider enabled" });
      try {
        const body = await readJson(req);
        if (typeof body.audio !== "string" || body.audio === "") {
          return sendJson(res, 400, { ok: false, error: "audio is required" });
        }
        if (runtime.asrEnabled.length === 0) {
          return sendJson(res, 503, { ok: false, error: "no ASR provider enabled" });
        }
        const defaultProvider = runtime.asrConfig?.provider;
        const payload = body.providers === undefined
          ? {
            ...body,
            providers: runtime.asrEnabled,
            ...(defaultProvider ? { provider: defaultProvider } : {}),
          }
          : body;
        const result = await runtime.asr.transcribe({
          ...payload,
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });
        sendJson(res, 200, result);
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
    path: "/companion/providers",
    handler: async (req, res) => {
      if (methodIs(req, "GET")) {
        return sendJson(res, 200, { ok: true, ...providerSnapshot(runtime) });
      }
      if (!methodIs(req, "POST")) return sendJson(res, 405, { ok: false, error: "use GET or POST" });
      try {
        const body = await readJson(req);
        const merged = mergeProviderUpdate(runtime.loaded.config, body);
        if (merged.error) return sendJson(res, 400, { ok: false, error: merged.error });
        writeConfig(configFile, merged.config);
        loaded = { config: merged.config, source: "file", error: null, file: configFile };
        runtime = buildRuntime(loaded, fallbackLoggedAt);
        return sendJson(res, 200, { ok: true, ...providerSnapshot(runtime) });
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
          const response = await fetch(`${base}/health`, {
            signal: AbortSignal.timeout(2_500),
          });
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
          return {
            name: provider.name,
            enabled: provider.enabled !== false,
            ok: false,
            configured: null,
            error: describeError(error),
          };
        }
      }));
      return sendJson(res, 200, { ok: true, providers });
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/companion/health",
    handler: async (req, res) => {
      if (!methodIs(req, "GET")) return sendJson(res, 405, { ok: false, error: "use GET" });
      sendJson(res, 200, {
        ok: true,
        tts: runtime.providers.map((provider) => provider.name),
        asr: runtime.asr ? runtime.asr.name : null,
        asrProvider: runtime.asrConfig?.provider || null,
        asrProviders: runtime.asrEnabled,
        source: runtime.loaded.source,
        configError: runtime.loaded.error,
        providers: providerSnapshot(runtime),
      });
    },
  }));
}
