import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(value) {
      this.body = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""));
    },
  };
}

function request(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.url = url;
  return stream;
}

function tempHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, "companion"), { recursive: true });
  return home;
}

function writeAdapters(home, config) {
  fs.writeFileSync(path.join(home, "companion", "adapters.json"), JSON.stringify(config));
}

async function loadPlugin() {
  return import("../lib/index.js");
}

test("adapter plugin exposes TTS, ASR, voices and health with configured providers", async () => {
  const home = tempHome("companion-adapters-");
  writeAdapters(home, {
    tts: [{ name: "fake", url: "http://fake/tts" }],
    asr: { name: "fake-asr", url: "http://fake/asr" },
  });
  const originalHome = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  process.env.DSH_HOME = home;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/tts")) {
      return new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    }
    if (String(url).endsWith("/asr")) {
      return Response.json({ text: "识别结果" });
    }
    if (String(url).includes("/voices")) {
      return Response.json({ ok: true, count: 1, voices: [{ shortName: "zh-CN-XiaoxiaoNeural" }] });
    }
    return new Response("not found", { status: 404 });
  };

  const routes = [];
  const ctx = {
    effect(fn) { fn(); },
    webServer: { register(route) { routes.push(route); return () => {}; } },
  };
  const plugin = await loadPlugin();
  try {
    plugin.apply(ctx);
    assert.deepEqual(routes.map((route) => route.path), [
      "/companion/tts",
      "/companion/asr",
      "/companion/voices",
      "/companion/providers",
      "/companion/tts/health",
      "/companion/health",
    ]);

    const ttsRes = fakeResponse();
    await routes[0].handler(request("POST", "/companion/tts", { text: "你好" }), ttsRes);
    assert.equal(ttsRes.statusCode, 200);
    assert.equal(ttsRes.headers["content-type"], "audio/mpeg");
    assert.equal(ttsRes.headers["x-tts-provider"], "fake");
    assert.deepEqual([...ttsRes.body], [7, 8, 9]);

    const asrRes = fakeResponse();
    await routes[1].handler(request("POST", "/companion/asr", { audio: "aGk=" }), asrRes);
    assert.equal(asrRes.statusCode, 200);
    assert.equal(JSON.parse(String(asrRes.body)).text, "识别结果");

    const voicesRes = fakeResponse();
    await routes[2].handler(request("GET", "/companion/voices?locale=zh-CN"), voicesRes);
    assert.equal(voicesRes.statusCode, 200);
    assert.equal(JSON.parse(String(voicesRes.body)).voices[0].shortName, "zh-CN-XiaoxiaoNeural");
    assert.ok(calls.some((url) => url === "http://fake/voices?locale=zh-CN"));

    const providersRes = fakeResponse();
    await routes[3].handler(request("GET", "/companion/providers"), providersRes);
    assert.equal(providersRes.statusCode, 200);
    assert.equal(JSON.parse(String(providersRes.body)).tts[0].name, "fake");

    const healthRoute = routes.find((route) => route.path === "/companion/health");
    const healthRes = fakeResponse();
    await healthRoute.handler(request("GET", "/companion/health"), healthRes);
    assert.equal(healthRes.statusCode, 200);
    const health = JSON.parse(String(healthRes.body));
    assert.deepEqual(health.tts, ["fake"]);
    assert.equal(health.asr, "fake-asr");
    assert.equal(health.source, "file");
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    globalThis.fetch = originalFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("missing adapters config defaults to the local edge service", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "companion-adapters-default-"));
  const originalHome = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  process.env.DSH_HOME = home;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  };
  const routes = [];
  const ctx = { effect(fn) { fn(); }, webServer: { register(route) { routes.push(route); return () => {}; } } };
  const plugin = await loadPlugin();
  try {
    plugin.apply(ctx);
    const providersRes = fakeResponse();
    await routes[3].handler(request("GET", "/companion/providers"), providersRes);
    assert.equal(providersRes.statusCode, 200);
    assert.equal(JSON.parse(String(providersRes.body)).tts[0].name, "edge");

    const healthRoute = routes.find((route) => route.path === "/companion/health");
    const healthRes = fakeResponse();
    await healthRoute.handler(request("GET", "/companion/health"), healthRes);
    const health = JSON.parse(String(healthRes.body));
    assert.deepEqual(health.tts, ["edge"]);
    assert.equal(health.source, "default-edge");

    const ttsRes = fakeResponse();
    await routes[0].handler(request("POST", "/companion/tts", { text: "你好" }), ttsRes);
    assert.equal(ttsRes.statusCode, 200);
    assert.equal(ttsRes.headers["x-tts-provider"], "edge");
    assert.equal(calls[0], "http://127.0.0.1:9003/tts");
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    globalThis.fetch = originalFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an explicit empty provider list keeps the 503 behavior", async () => {
  const home = tempHome("companion-adapters-empty-");
  writeAdapters(home, { tts: [], asr: null });
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = [];
  const ctx = { effect(fn) { fn(); }, webServer: { register(route) { routes.push(route); return () => {}; } } };
  const plugin = await loadPlugin();
  try {
    plugin.apply(ctx);
    const res = fakeResponse();
    await routes[0].handler(request("POST", "/companion/tts", { text: "你好" }), res);
    assert.equal(res.statusCode, 503);
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("TTS upstream failures surface their detail", async () => {
  const home = tempHome("companion-adapters-fail-");
  writeAdapters(home, { tts: [{ name: "fake", url: "http://fake/tts" }] });
  const originalHome = process.env.DSH_HOME;
  const originalFetch = globalThis.fetch;
  process.env.DSH_HOME = home;
  globalThis.fetch = async () => new Response("provider exploded", { status: 500 });
  const routes = [];
  const ctx = { effect(fn) { fn(); }, webServer: { register(route) { routes.push(route); return () => {}; } } };
  const plugin = await loadPlugin();
  try {
    plugin.apply(ctx);
    const res = fakeResponse();
    await routes[0].handler(request("POST", "/companion/tts", { text: "你好" }), res);
    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(String(res.body)).error, /HTTP 500/);
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    globalThis.fetch = originalFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("provider route changes TTS order, enables/disables providers and ASR", async () => {
  const home = tempHome("companion-adapters-providers-");
  writeAdapters(home, {
    tts: [
      { name: "a", url: "http://a/tts" },
      { name: "b", url: "http://b/tts" },
    ],
    asr: { name: "asr", url: "http://asr/asr", provider: "auto" },
  });
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = [];
  const ctx = { effect(fn) { fn(); }, webServer: { register(route) { routes.push(route); return () => {}; } } };
  const plugin = await loadPlugin();
  try {
    plugin.apply(ctx);
    const providersRoute = routes.find((route) => route.path === "/companion/providers");
    const update = fakeResponse();
    await providersRoute.handler(request("POST", "/companion/providers", {
      tts: [{ name: "b", enabled: true }, { name: "a", enabled: false }],
      asr: { enabled: false },
    }), update);
    assert.equal(update.statusCode, 200);
    const updated = JSON.parse(String(update.body));
    assert.deepEqual(updated.tts.map((provider) => [provider.name, provider.enabled]), [["b", true], ["a", false]]);
    assert.equal(updated.asr.enabled, false);

    const healthRoute = routes.find((route) => route.path === "/companion/health");
    const healthRes = fakeResponse();
    await healthRoute.handler(request("GET", "/companion/health"), healthRes);
    const health = JSON.parse(String(healthRes.body));
    assert.deepEqual(health.tts, ["b"]);
    assert.equal(health.asr, null);

    const saved = JSON.parse(fs.readFileSync(path.join(home, "companion", "adapters.json"), "utf8"));
    assert.deepEqual(saved.tts.map((provider) => [provider.name, provider.enabled]), [["b", true], ["a", false]]);
    assert.equal(saved.asr.enabled, false);

    await providersRoute.handler(request("POST", "/companion/providers", {
      tts: [{ name: "a", enabled: true }, { name: "b", enabled: true }],
      asr: {
        enabled: true,
        providers: [
          { name: "sensevoice", enabled: true },
          { name: "zipformer", enabled: false },
          { name: "qwen3", enabled: false },
        ],
      },
    }), fakeResponse());
    const restored = fakeResponse();
    await healthRoute.handler(request("GET", "/companion/health"), restored);
    const restoredHealth = JSON.parse(String(restored.body));
    assert.deepEqual(restoredHealth.tts, ["a", "b"]);
    assert.deepEqual(restoredHealth.asrProviders, ["sensevoice"]);
    const restoredProviders = JSON.parse(String((await (async () => {
      const response = fakeResponse();
      await providersRoute.handler(request("GET", "/companion/providers"), response);
      return response;
    })()).body));
    assert.deepEqual(restoredProviders.asr.providers.map((provider) => [provider.name, provider.enabled]), [
      ["sensevoice", true],
      ["zipformer", false],
      ["qwen3", false],
    ]);
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("wrong HTTP methods are rejected", async () => {
  const home = tempHome("companion-adapters-method-");
  writeAdapters(home, { tts: [{ name: "fake", url: "http://fake/tts" }] });
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = [];
  const ctx = { effect(fn) { fn(); }, webServer: { register(route) { routes.push(route); return () => {}; } } };
  const plugin = await loadPlugin();
  try {
    plugin.apply(ctx);
    const res = fakeResponse();
    await routes[0].handler(request("GET", "/companion/tts"), res);
    assert.equal(res.statusCode, 405);
  } finally {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
