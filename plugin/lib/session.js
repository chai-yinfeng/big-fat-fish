/**
 * Session reading helpers shared by the plugin shell.
 *
 * DSH dispatches `session/event` for every committed log entry. Keeping a tiny
 * mirror of the latest user/assistant message per session is cheaper and more
 * precise than rescanning the whole transcript on every turn boundary, and it
 * tells a real user turn apart from a proactive instruction this plugin wrote.
 */

export const SOURCE_KIND = "plugin:companion-core";

export function sessionIdOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  for (const key of ["id", "sessionId", "key"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  if (value.session) return sessionIdOf(value.session);
  return "";
}

function contentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Extract model-visible text from a user/assistant message shape. */
export function messageText(message) {
  if (!message) return "";
  if (typeof message === "string") return message.trim();
  if (Array.isArray(message.content)) return contentText(message.content);
  if (typeof message.text === "string") return message.text.trim();
  if (message.message) return messageText(message.message);
  if (message.data) return messageText(message.data);
  return "";
}

export function sourceKindOf(message) {
  const source = message?.source;
  return typeof source?.kind === "string" ? source.kind : "";
}

/** A user-authored message, including IM bridges, but never our own prompt. */
export function isUserSource(kind) {
  if (kind === "user") return true;
  return typeof kind === "string" && kind.startsWith("plugin:") && kind !== SOURCE_KIND;
}

export function makeUserMessage(text, sourceKind = SOURCE_KIND) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: "user",
    content: [{ type: "text", text: String(text) }],
    source: { kind: sourceKind },
  };
}

function safeEvents(session) {
  try {
    return session?.snapshotEvents?.() ?? [];
  } catch {
    return [];
  }
}

export function lastUserMessageFromSession(session) {
  const events = safeEvents(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "user/message") continue;
    const kind = sourceKindOf(event.data);
    if (!isUserSource(kind)) continue;
    const text = messageText(event.data);
    if (text) return { text, at: event.time, seq: event.seq, source: kind };
  }
  return null;
}

export function lastAssistantMessageFromSession(session) {
  const events = safeEvents(session);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const text = messageText(event.data?.message ?? event.data);
    if (text) return { text, at: event.time, seq: event.seq };
  }
  return null;
}

/** Last complete-ish turn, used by manual extraction when no live mirror exists. */
export function lastTurnFromSession(session) {
  const events = safeEvents(session);
  let assistant = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "assistant/message") {
      const text = messageText(event.data?.message ?? event.data);
      if (text) {
        assistant = { text, at: event.time, seq: event.seq };
        break;
      }
    }
  }
  const limit = assistant ? assistant.seq : events.length;
  let user = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.seq > limit) continue;
    if (event.type !== "user/message") continue;
    const kind = sourceKindOf(event.data);
    if (!isUserSource(kind)) continue;
    const text = messageText(event.data);
    if (text) {
      user = { text, at: event.time, seq: event.seq, source: kind };
      break;
    }
  }
  return { user, assistant, proactive: false };
}

export function createSessionMirror() {
  const sessions = new Map();

  function state(sessionId) {
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = { user: null, assistant: null, proactive: false, handledTurn: null };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  return {
    observe(session, event) {
      const sessionId = sessionIdOf(session);
      if (!sessionId || !event) return;
      const entry = state(sessionId);
      const data = event.data ?? {};
      if (event.type === "turn/start") {
        entry.user = null;
        entry.assistant = null;
        entry.proactive = false;
        return;
      }
      if (event.type === "user/message") {
        const kind = sourceKindOf(data);
        const text = messageText(data);
        if (!text) return;
        if (kind === SOURCE_KIND) {
          entry.proactive = true;
          entry.user = null;
        } else if (isUserSource(kind)) {
          entry.proactive = false;
          entry.user = { text, at: event.time, seq: event.seq, source: kind };
        }
        return;
      }
      if (event.type === "assistant/message") {
        const text = messageText(data.message ?? data);
        if (text) entry.assistant = { text, at: event.time, seq: event.seq };
      }
    },

    lastTurn(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return { user: null, assistant: null, proactive: false };
      return {
        user: entry.user ? { ...entry.user } : null,
        assistant: entry.assistant ? { ...entry.assistant } : null,
        proactive: entry.proactive,
      };
    },

    noteProactive(sessionId) {
      const entry = state(sessionId);
      entry.proactive = true;
      entry.user = null;
    },

    /** True only the first time a turn number is handled. */
    claimTurn(sessionId, turn) {
      if (!Number.isFinite(turn)) return true;
      const entry = state(sessionId);
      if (entry.handledTurn === turn) return false;
      entry.handledTurn = turn;
      return true;
    },

    forget(sessionId) {
      sessions.delete(sessionId);
    },

    size() {
      return sessions.size;
    },
  };
}

const SPEECH_NOISE = [
  [/```[\s\S]*?```/g, " "],
  [/~~~[\s\S]*?~~~/g, " "],
  [/`([^`]*)`/g, "$1"],
  [/!\[[^\]]*\]\([^)]*\)/g, " "],
  [/\[([^\]]*)\]\(([^)]*)\)/g, "$1"],
  [/https?:\/\/\S+/gi, " "],
  [/<\/?[a-z][^>]*>/gi, " "],
  [/^\s{0,3}#{1,6}\s+/gm, ""],
  [/^\s{0,3}>\s?/gm, ""],
  [/^\s*[-*+]\s+/gm, ""],
  [/^\s*\d+[.)]\s+/gm, ""],
  [/[*_~]/g, ""],
];

/** Strip code, URLs and markup, then normalize whitespace. */
export function sanitizeSpeechText(markdown) {
  let text = String(markdown ?? "");
  for (const [pattern, replacement] of SPEECH_NOISE) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  return text;
}

/** Full speakable text, capped. Used by explicit /companion speak. */
export function toSpeechText(markdown, maxChars = 400) {
  const text = sanitizeSpeechText(markdown);
  if (text === "") return "";
  const limit = Math.max(1, Number(maxChars) || 400);
  if (text.length > limit) {
    return `${text.slice(0, limit - 1).trimEnd()}…`;
  }
  return text;
}

/**
 * A short spoken line for automatic replies: full sentences only, stopping
 * before the budget is exceeded. A long technical answer therefore gets its
 * opening sentence read instead of the whole wall of text.
 */
export function toAutoSpeechText(markdown, maxChars = 120) {
  const text = sanitizeSpeechText(markdown);
  if (text === "") return "";
  const limit = Math.max(1, Number(maxChars) || 120);
  const sentences = text.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [text];
  let output = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence === "") continue;
    if (output.length + sentence.length > limit) {
      if (output === "") {
        output = `${sentence.slice(0, limit - 1).trimEnd()}…`;
      }
      break;
    }
    output += sentence;
  }
  return output.trim();
}
