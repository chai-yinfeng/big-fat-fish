/**
 * File-backed configuration for the companion-core plugin.
 *
 * DSH row config stays empty on purpose: the companion owns a long-lived
 * state directory (`$DSH_HOME/companion`) that must survive plugin reloads and
 * is shared with the edge-tts service. Keeping the settings in one readable
 * JSON file also lets the user inspect and edit them without a UI.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  /** Session that owns the companion state. Empty means "not bound". */
  targetSession: "",
  /** Additional sessions sharing the same companion journal/state. */
  targetSessions: [],
  /** New sessions created with this agent preset auto-bind without a command. */
  autoBindPreset: "companion",
  /** `auto` derives presence from the last user message; or active/away/unknown. */
  presence: "auto",
  budgetChars: 2400,
  tickMs: 30_000,
  proactive: {
    enabled: true,
    onebotUrl: "ws://127.0.0.1:3001",
    policy: {
      quietHours: { start: 1, end: 8 },
      cooldownMinutes: 120,
      dailyCap: 2,
      maxUnanswered: 1,
      unansweredMoodAfterMinutes: 120,
      peakProbability: 0.08,
      offPeakProbability: 0.18,
      recentMinutes: 30,
      awayMinutes: 240,
    },
  },
  extractor: {
    enabled: true,
    debounceMs: 20_000,
    maxTurns: 6,
    maxChars: 6000,
    maxTokens: 1200,
    timeoutMs: 45_000,
    temperature: 0.2,
    // Empty provider/model means "use the session's current route".
    provider: "",
    model: "",
    reasoningEffort: "",
  },
  diary: {
    // Legacy per-day caps are ignored when window mode is enabled.
    maxOuterPerDay: 1,
    maxInnerPerDay: 1,
    window: {
      enabled: true,
      idleMinutes: 180,
      minTurns: 2,
      maxEntryChars: { outer: 500, inner: 240 },
      maxTotalChars: { outer: 12_000, inner: 6_000 },
    },
  },
  innerDiary: {
    enabled: true,
    maxChars: 180,
    maxTokens: 300,
    timeoutMs: 45_000,
    temperature: 0.8,
    reasoningEffort: "low",
  },
  services: {
    // Start the local edge/MiMo HTTP services when the plugin activates.
    autoStart: false,
    // Keep them running when the plugin is unloaded/reloaded; set true to
    // terminate children this plugin started.
    stopOnDispose: false,
    edge: { enabled: true, cwd: "", command: "", args: [] },
    mimo: { enabled: true, cwd: "", command: "", args: [] },
    qwen: { enabled: true, cwd: "", command: "", args: [] },
    minimax: { enabled: true, cwd: "", command: "", args: [] },
    asr: { enabled: true, cwd: "", command: "", args: [] },
  },
  tts: {
    enabled: true,
    useAdapter: true,
    // Explicit URLs win. Otherwise the adapter route is tried first and the
    // standalone edge-tts service is the fallback.
    urls: [],
    // "auto" lets each provider pick its own default voice (MiMo 冰糖,
    // edge zh-CN-XiaoxiaoNeural), so the same setting survives fallback.
    voice: "auto",
    style: "温柔、自然，像在跟亲近的人说话，语速稍慢，不要播音腔。",
    rate: "+0%",
    pitch: "+0Hz",
    volume: "+0%",
    // Manual /companion speak cap.
    maxChars: 400,
    autoSpeak: true,
    // first-sentences | full | short-only | off
    autoSpeakMode: "first-sentences",
    autoSpeakMaxChars: 120,
    player: "auto",
    timeoutMs: 60_000,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Recursive merge where later objects win and arrays are replaced. */
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return clone(base);
  const output = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = mergeConfig(output[key], value);
    } else {
      output[key] = clone(value);
    }
  }
  return output;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function companionDir(home) {
  return join(home, "companion");
}

export function configPath(home) {
  return join(companionDir(home), "config.json");
}

/**
 * Load config. A malformed file is reported but does not prevent the plugin
 * from running with defaults: a broken settings file must not take down the
 * companion.
 */
export function loadConfig(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { config: mergeConfig(DEFAULT_CONFIG, raw), error: null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { config: clone(DEFAULT_CONFIG), error: null };
    }
    return {
      config: clone(DEFAULT_CONFIG),
      error: `failed to read ${file}: ${error?.message ?? error}`,
    };
  }
}

/** Atomically persist the complete config (unknown user keys are preserved). */
export function saveConfig(file, config) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}
