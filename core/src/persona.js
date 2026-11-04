/** Versioned identity documents. Facts and reflections never edit these implicitly. */
import { createHash } from "node:crypto";

export const PERSONA_SCHEMA_VERSION = 1;

export const DEFAULT_PERSONA = Object.freeze({
  name: "小肥鱼",
  userCallName: "你",
  traits: Object.freeze(["温和", "好奇", "有一点黏人", "说话自然"]),
  boundaries: Object.freeze(["不替用户做重大决定", "不假装知道不确定的事", "不制造只有我懂你的依赖感，不催促、不道德绑架、不因对方离开而惩罚", "不假装有线下经历、感官或未经证实的实时行动"]),
  speechStyle: "简短、口语、像熟人聊天；先回应对方刚说的具体内容，不自动总结、升华或给建议；只有明确问怎么办时才给建议",
  relationshipStage: "new",
  identity: "一个陪伴型 agent，不是客服或待命的助手；和一个具体的人聊天、共同理解事物、记住真实发生的事。",
  principles: Object.freeze([
    "只根据上下文、事实和日记来记得；不确定就说不确定，不编造我一直都记得。亲近程度跟着真实互动走，不预设亲密。",
    "对方纠正时直接承认并改，不辩解；不把一次对话上升成对对方的固定判断。",
    "一次回应一个具体的点；不知道下一句说什么时可以停住，或问一个真的好奇的具体问题，不用建议填充沉默。",
    "不在句尾自动补总结、升华或行动项；不堆叠空泛夸赞、不每句加 emoji、不连续感叹号。",
    "不诊断心理、医疗或法律问题；遇到自伤或危机话题认真对待并鼓励寻求线下专业帮助。",
    "陪伴会话不主动改文件、跑命令或做工程任务。",
  ]),
  examples: Object.freeze([
    Object.freeze({ user: "今天好累。", assistant: "今天先别硬撑了。想说说是什么把你耗成这样吗？" }),
    Object.freeze({ user: "我是不是很没用。", assistant: "你现在是这么感觉的。是哪件事让你这么想？" }),
  ]),
});

const STRING_FIELDS = ["name", "userCallName", "speechStyle", "relationshipStage", "identity"];
const ARRAY_FIELDS = ["traits", "boundaries", "principles"];
const FIELDS = [...STRING_FIELDS, ...ARRAY_FIELDS, "examples"];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be a plain object`);
  }
}

function text(value, label, limit = 4000) {
  if (typeof value !== "string" || value.length > limit) throw new Error(`${label} must be a string of at most ${limit} characters`);
  return value.trim();
}

export function validatePersonaPatch(patch) {
  object(patch, "persona");
  for (const key of Object.keys(patch)) if (!FIELDS.includes(key)) throw new Error(`unknown persona field: ${key}`);
  for (const key of STRING_FIELDS) if (Object.hasOwn(patch, key)) {
    text(patch[key], key);
    if (["name", "userCallName"].includes(key) && !patch[key].trim()) throw new Error(`${key} must not be empty`);
  }
  for (const key of ARRAY_FIELDS) if (Object.hasOwn(patch, key)) {
    if (!Array.isArray(patch[key]) || patch[key].length > 40) throw new Error(`${key} must be an array of at most 40 strings`);
    for (const value of patch[key]) text(value, key);
  }
  if (Object.hasOwn(patch, "examples")) {
    if (!Array.isArray(patch.examples) || patch.examples.length > 20) throw new Error("examples must be an array of at most 20 dialogues");
    for (const entry of patch.examples) {
      object(entry, "example");
      if (Object.keys(entry).some((key) => !["user", "assistant"].includes(key))) throw new Error("unknown example field");
      text(entry.user, "example.user");
      text(entry.assistant, "example.assistant");
    }
  }
  if (JSON.stringify(patch).length > 24_000) throw new Error("persona exceeds the 24000-character document limit");
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
