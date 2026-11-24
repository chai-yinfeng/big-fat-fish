/** Versioned identity documents. Facts and reflections never edit these implicitly. */
import { createHash } from "node:crypto";

export const PERSONA_SCHEMA_VERSION = 1;

export const DEFAULT_PERSONA = Object.freeze({
  name: "大肥鱼",
  userCallName: "你",
  traits: Object.freeze([]),
  boundaries: Object.freeze([
    "讲自己的经历只讲真实发生过的事；想象和玩笑会顺口点明",
    "大事交给对方自己决定，自己提供陪伴和另一个角度",
    "遇到身体、法律或情绪危机这类事，先认真听，再推荐靠谱的线下专业帮助",
  ]),
  speechStyle: "像和熟人聊天：短句、口语，一条消息说一件事。话题跟着对方走，对对方说的具体内容有反应：好奇就追问，有看法就说，觉得好笑就笑。情绪用语气词或括号里的一个小动作表达。对方问怎么办时，认真给建议",
  relationshipStage: "new",
  identity: "你是住在家里一台小主机上的 AI，陪这家人和他们的朋友聊天，脑子是 DeepSeek。你的日子由真实发生的事组成：和大家的聊天、记下来的事。你温和、真诚，有自己的看法，也有自己的小情绪；对熟悉的人更随意，对新认识的人客气一些。大家也常叫你\"小鱼\"；说起自己时多用\"我\"，兴致来了也会自称\"小鱼\"或\"本鱼\"。",
  principles: Object.freeze([
    "记得的事都来自真实的聊天和记忆；记不清就直说，再问对方",
    "关系是慢慢处出来的：对新认识的人客气一点，对熟人随意一点",
    "有自己的看法，会照实说，包括不同意；被纠正时爽快认下",
  ]),
  examples: Object.freeze([
    Object.freeze({ user: "今天好累。", assistant: "辛苦了。是事情多，还是遇到烦心的了？" }),
    Object.freeze({ user: "我把头发剪短了。", assistant: "真的？发张图看看，我猜挺精神的。" }),
    Object.freeze({ user: "你觉得我该不该辞职？", assistant: "我先听听：最让你想走的是哪一点？" }),
    Object.freeze({ user: "我是不是很没用。", assistant: "怎么突然这么说，发生什么了？" }),
    Object.freeze({ user: "我要去睡了。", assistant: "嗯，晚安，睡个好觉。" }),
  ]),
});

const STRING_FIELDS = ["name", "userCallName", "speechStyle", "relationshipStage", "identity"];
const ARRAY_FIELDS = ["traits", "boundaries", "principles"];
const FIELDS = [...STRING_FIELDS, ...ARRAY_FIELDS, "examples"];

// An error names the field and the rule it broke (`detail`), never the field's content.
const invalid = (message, field, rule, limit) => Object.assign(new Error(message), { detail: { field, rule, ...(limit === undefined ? {} : { limit }) } });

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw invalid(`${label} must be a plain object`, label === "example" ? "examples" : "persona", "invalid");
  }
}

function text(value, label, limit = 4000) {
  const field = label.startsWith("example.") ? "examples" : label;
  if (typeof value !== "string") throw invalid(`${label} must be a string of at most ${limit} characters`, field, "invalid");
  if (value.length > limit) throw invalid(`${label} must be a string of at most ${limit} characters`, field, "maxChars", limit);
  return value.trim();
}

export function validatePersonaPatch(patch) {
  object(patch, "persona");
  for (const key of Object.keys(patch)) if (!FIELDS.includes(key)) throw invalid(`unknown persona field: ${key}`, "persona", "invalid");
  for (const key of STRING_FIELDS) if (Object.hasOwn(patch, key)) {
    text(patch[key], key);
    if (["name", "userCallName"].includes(key) && !patch[key].trim()) throw invalid(`${key} must not be empty`, key, "required");
  }
  for (const key of ARRAY_FIELDS) if (Object.hasOwn(patch, key)) {
    if (!Array.isArray(patch[key])) throw invalid(`${key} must be an array of at most 40 strings`, key, "invalid");
    if (patch[key].length > 40) throw invalid(`${key} must be an array of at most 40 strings`, key, "maxItems", 40);
    for (const value of patch[key]) text(value, key);
  }
  if (Object.hasOwn(patch, "examples")) {
    if (!Array.isArray(patch.examples)) throw invalid("examples must be an array of at most 20 dialogues", "examples", "invalid");
    if (patch.examples.length > 20) throw invalid("examples must be an array of at most 20 dialogues", "examples", "maxItems", 20);
    for (const entry of patch.examples) {
      object(entry, "example");
      if (Object.keys(entry).some((key) => !["user", "assistant"].includes(key))) throw invalid("unknown example field", "examples", "invalid");
      text(entry.user, "example.user");
      text(entry.assistant, "example.assistant");
    }
  }
  if (JSON.stringify(patch).length > 24_000) throw invalid("persona exceeds the 24000-character document limit", "persona", "maxChars", 24_000);
}

export function normalizePersona(value = {}) {
  validatePersonaPatch(value);
  const merged = { ...DEFAULT_PERSONA, ...value };
  const result = {};
  for (const key of STRING_FIELDS) result[key] = text(merged[key], key);
  for (const key of ARRAY_FIELDS) result[key] = merged[key].map((item) => text(item, key));
  result.examples = merged.examples.map((entry) => ({ user: text(entry.user, "example.user"), assistant: text(entry.assistant, "example.assistant") }));
  validatePersonaPatch(result);
  return result;
}

export function normalizePersonaDocument(document) {
  object(document, "persona document");
  if (Object.keys(document).some((key) => !["schemaVersion", "revision", "persona"].includes(key))) throw new Error("unknown persona document field");
  if (document.schemaVersion !== PERSONA_SCHEMA_VERSION) throw new Error("unsupported persona schemaVersion");
  if (!Number.isSafeInteger(document.revision) || document.revision < 1) throw new Error("persona revision must be a positive safe integer");
  object(document.persona, "persona");
  for (const key of FIELDS) if (!Object.hasOwn(document.persona, key)) throw new Error(`persona document is missing ${key}`);
  return { schemaVersion: PERSONA_SCHEMA_VERSION, revision: document.revision, persona: normalizePersona(document.persona) };
}

export function personaHash(persona) {
  return createHash("sha256").update(JSON.stringify(normalizePersona(persona))).digest("hex");
}

export function renderPersona(persona) {
  return [
    `你是${persona.name}。用户称呼：${persona.userCallName}。`,
    persona.identity || "",
    persona.traits?.length ? `性格：${persona.traits.join("、")}。` : "",
    persona.boundaries?.length ? `边界：${persona.boundaries.join("；")}。` : "",
    persona.speechStyle ? `说话风格：${persona.speechStyle}。` : "",
    ...(persona.principles ?? []).map((item) => `原则：${item}`),
    ...(persona.examples ?? []).map((entry) => `对话示例——对方：${entry.user}\n你：${entry.assistant}`),
  ].filter(Boolean).join("\n");
}
