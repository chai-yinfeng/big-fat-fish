import { createHash } from "node:crypto";

/** An explicit write by the bound companion, not an extractor/model side-pass. */
export function writeInnerDiary({ core, config, sessionId, isBound, text, key }) {
  if (!core) throw new Error("companion core is not ready");
  if (!isBound(sessionId)) throw new Error("only a bound companion may write inner diary");
  if (!config.innerDiary?.enabled) throw new Error("inner diary is disabled");
  if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
  if (typeof key !== "string" || !key.trim() || key.length > 96) throw new Error("key must contain 1–96 characters");
  const value = text.trim();
  const limit = Number(config.diary?.window?.maxEntryChars?.inner) || 240;
  if (value.length > limit) throw new Error(`inner diary exceeds ${limit} characters; shorten it deliberately`);
  const tag = `inner-key:${createHash("sha256").update(`${sessionId}\n${key}`).digest("hex")}`;
  const prior = core.snapshot().diary.find((entry) => entry.kind === "inner" && entry.tags?.includes(tag));
  if (prior) {
    if (prior.text !== value) throw new Error("key already identifies another inner diary entry");
    return { saved: true, duplicate: true, id: prior.id, chars: prior.text.length };
  }
  const entry = core.addDiary({ text: value, kind: "inner", tags: ["self-written", "agent-decided", tag] });
  core.pruneDiary({ kind: "inner", maxChars: Number(config.diary?.window?.maxTotalChars?.inner) || 6000 });
  return { saved: true, duplicate: false, id: entry.id, chars: value.length };
}

export function innerDiaryTool(write) {
  return {
    name: "companion_inner_diary",
    description: "保存你自己决定留下的私密内心日记。没有值得留下的感受或理解时不调用；不必每轮或每个视频写。",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        text: { type: "string", description: "第一人称正文，最多240字；不复述凭据或隐私。" },
        key: { type: "string", description: "本次经历的稳定标识，1–96字符；重试沿用同一个。" },
      }, required: ["text", "key"],
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => write(args, exec.agent),
  };
}
