import test from "node:test";
import assert from "node:assert/strict";
import { createTtsRouter } from "../src/tts-router.js";

function provider(name, behavior) {
  return {
    name,
    async synthesize(request) {
      if (behavior instanceof Error) throw behavior;
      return { audio: new Uint8Array([1]), mime: "audio/mpeg", echo: request.text };
    },
  };
}

test("TTS router falls back in order and reports the fallback", async () => {
  const events = [];
  const router = createTtsRouter({
    providers: [
      provider("minimax", new Error("quota")),
      provider("aliyun", new Error("timeout")),
      provider("edge", null),
    ],
    onFallback: (event) => events.push(event),
  });
  const result = await router.synthesize({ text: "你好" });
  assert.equal(result.provider, "edge");
  assert.equal(result.cached, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].errors.length, 2);
});

test("TTS router caches successful output and honors prefer", async () => {
  const calls = [];
  const router = createTtsRouter({
    providers: [
      { name: "a", async synthesize() { calls.push("a"); return { audio: new Uint8Array([1]), mime: "audio/mpeg" }; } },
      { name: "b", async synthesize() { calls.push("b"); return { audio: new Uint8Array([2]), mime: "audio/mpeg" }; } },
    ],
  });
  const first = await router.synthesize({ text: "x" }, { prefer: "b" });
  assert.equal(first.provider, "b");
  const second = await router.synthesize({ text: "x" }, { prefer: "b" });
  assert.equal(second.cached, true);
  assert.deepEqual(calls, ["b"]);
});

test("TTS router throws AggregateError when every provider fails", async () => {
  const router = createTtsRouter({
    providers: [provider("a", new Error("x")), provider("b", new Error("y"))],
  });
  await assert.rejects(() => router.synthesize({ text: "x" }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
});

test("TTS router passes the abort signal without changing the cache key", async () => {
  const seen = [];
  const router = createTtsRouter({
    providers: [{
      name: "a",
      async synthesize(request) {
        seen.push(request.signal);
        return { audio: new Uint8Array([1]), mime: "audio/mpeg" };
      },
    }],
  });
  const controller = new AbortController();
  const first = await router.synthesize({ text: "x", signal: controller.signal });
  assert.equal(seen[0], controller.signal);
  assert.equal(first.cached, false);
  const second = await router.synthesize({ text: "x", signal: new AbortController().signal });
  assert.equal(second.cached, true);
  assert.equal(seen.length, 1);
});

test("TTS router does not cache a fallback result", async () => {
  let primaryCalls = 0;
  let secondaryCalls = 0;
  const router = createTtsRouter({
    providers: [
      {
        name: "primary",
        async synthesize() {
          primaryCalls += 1;
          throw new Error("primary down");
        },
      },
      {
        name: "secondary",
        async synthesize() {
          secondaryCalls += 1;
          return { audio: new Uint8Array([1]), mime: "audio/mpeg" };
        },
      },
    ],
  });
  const first = await router.synthesize({ text: "x" });
  assert.equal(first.provider, "secondary");
  assert.equal(first.cached, false);
  const second = await router.synthesize({ text: "x" });
  assert.equal(second.provider, "secondary");
  assert.equal(second.cached, false);
  assert.equal(primaryCalls, 2);
  assert.equal(secondaryCalls, 2);
});

test("TTS router expires cached output after the TTL", async () => {
  let clock = 0;
  let calls = 0;
  const router = createTtsRouter({
    cacheTtlMs: 1_000,
    now: () => clock,
    providers: [{
      name: "a",
      async synthesize() {
        calls += 1;
        return { audio: new Uint8Array([1]), mime: "audio/mpeg" };
      },
    }],
  });
  assert.equal((await router.synthesize({ text: "x" })).cached, false);
  clock = 500;
  assert.equal((await router.synthesize({ text: "x" })).cached, true);
  clock = 1_500;
  assert.equal((await router.synthesize({ text: "x" })).cached, false);
  assert.equal(calls, 2);
});
