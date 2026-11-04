import test from "node:test";
import assert from "node:assert/strict";
import { createHttpTtsAdapter } from "../src/http-tts.js";

test("HTTP TTS adapter posts JSON and returns audio bytes", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  };
  const adapter = createHttpTtsAdapter({
    url: "http://127.0.0.1:9000/tts",
    headers: { authorization: "Bearer test" },
    fetchImpl,
  });
  const result = await adapter.synthesize({ text: "你好", voice: "fish" });
  assert.equal(result.mime, "audio/wav");
  assert.deepEqual([...result.audio], [1, 2, 3]);
  assert.equal(captured.url, "http://127.0.0.1:9000/tts");
  assert.equal(JSON.parse(captured.init.body).text, "你好");
  assert.equal(captured.init.headers.authorization, "Bearer test");
});

test("HTTP TTS adapter surfaces status failures", async () => {
  const adapter = createHttpTtsAdapter({
    url: "http://example/tts",
    fetchImpl: async () => new Response("quota exceeded", { status: 429 }),
  });
  await assert.rejects(() => adapter.synthesize({ text: "hi" }), /HTTP 429/);
});

test("HTTP TTS adapter keeps the abort signal out of the JSON payload", async () => {
  let captured;
  const controller = new AbortController();
  const adapter = createHttpTtsAdapter({
    url: "http://example/tts",
    fetchImpl: async (_url, init) => {
      captured = init;
      return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });
  await adapter.synthesize({ text: "hi", signal: controller.signal });
  assert.equal(captured.signal, controller.signal);
  assert.equal(JSON.parse(captured.body).signal, undefined);
});
