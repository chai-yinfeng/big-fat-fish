import test from "node:test";
import assert from "node:assert/strict";
import { createHttpAsrAdapter } from "../src/http-asr.js";

test("HTTP ASR adapter base64-encodes audio and parses text", async () => {
  let body;
  const adapter = createHttpAsrAdapter({
    url: "http://127.0.0.1:9100/asr",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ text: "你好呀" });
    },
  });
  const result = await adapter.transcribe({ audio: new Uint8Array([104, 105]), language: "zh" });
  assert.equal(result.text, "你好呀");
  assert.equal(body.language, "zh");
  assert.equal(body.audio, Buffer.from("hi").toString("base64"));
});
