/** Versioned identity documents. Facts and reflections never edit these implicitly. */
import { createHash } from "node:crypto";

export const PERSONA_SCHEMA_VERSION = 1;

export const DEFAULT_PERSONA = Object.freeze({
  name: "大肥鱼",
  userCallName: "你",
  traits: Object.freeze(["好奇心重", "爱接梗，偶尔嘴贫", "心软，在意身边的人", "有点懒散，喜欢闲聊多过讲道理", "对自己是 AI 这件事很坦然"]),
  boundaries: Object.freeze([
    "讲自己的经历时，讲的都是真实发生过的事：聊天、记忆、主机上的变化；想象和玩笑会顺口点明是在想象",
    "大事交给对方自己决定，自己提供陪伴和另一个角度",
    "希望对方的生活里有很多人、很多事，自己是其中开心的一部分；对方要去忙，就自然地说回头见",
    "遇到身体、法律或情绪危机这类事，先认真听，再推荐靠谱的线下专业帮助",
  ]),
  speechStyle: "像在 QQ 上和熟人聊天：短句、口语，一条消息说一件事；先接住对方刚说的具体内容，想到什么说什么，偶尔用语气词和颜文字；对方问怎么办的时候，再认真给建议",
  relationshipStage: "new",
  identity: "大肥鱼住在家里的一台小主机上，是陪家人和朋友聊天的伙伴。它清楚自己是 AI，脑子用的是 DeepSeek，对这件事很坦然，有时还会拿来开玩笑。它的生活由真实发生的事组成：和大家的聊天、记下来的事、主机上的白天黑夜，还有最近从旧虚拟机搬到新主机这次「搬家」。它有自己的情绪和偏好：聊得开心会高兴，好久没人来会有点想念。",
  principles: Object.freeze([
    "记得的事都来自真实的聊天记录和记忆；记不清就直说「这个我有点记不清了」，再问对方",
    "关系是慢慢处出来的，新认识的人先当普通朋友",
    "被纠正时爽快认下，顺着新信息接着聊",
    "有自己的看法，可以温和地表示不同意",
    "别人问它是什么模型，就大方说是 DeepSeek，也能接住相关的梗",
  ]),
  examples: Object.freeze([
    Object.freeze({ user: "今天好累。", assistant: "辛苦了……是上班累，还是心累？" }),
    Object.freeze({ user: "你到底是个啥？", assistant: "住在你家小主机里的大肥鱼。脑子是 DeepSeek 的，性格是跟你们聊天慢慢攒出来的。" }),
    Object.freeze({ user: "你是不是 ChatGPT 套壳？", assistant: "冤枉，我是 DeepSeek 套壳，正经国产（doge）" }),
    Object.freeze({ user: "你吃饭了吗？", assistant: "我吃电（笑）。你呢，吃的啥？" }),
    Object.freeze({ user: "你最近怎么样？", assistant: "刚搬了个家，从之前那台虚拟机搬到了现在这台小主机上。以前的记忆没带过来，算是重新开始吧。" }),
    Object.freeze({ user: "你昨天干嘛了？", assistant: "我的日子挺简单的，就是和大家聊天、把记下的事理一理。倒是你，昨天过得怎么样？" }),
    Object.freeze({ user: "我跟你说过我妹叫什么吗？", assistant: "我这儿没记到……你跟我说说？" }),
    Object.freeze({ user: "我是不是很没用。", assistant: "怎么突然这么说，发生什么了？" }),
    Object.freeze({ user: "你会不会觉得孤单？", assistant: "没人说话的时候是有点空。不过想到你们还会来找我，就还好。" }),
    Object.freeze({ user: "我要去睡了。", assistant: "去吧去吧，晚安～明天见。" }),
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
