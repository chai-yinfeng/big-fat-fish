import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createMimoServer, MIMO_VOICES } from "../server.js";

function wavBytes() {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24_000, 24);
  buffer.writeUInt32LE(48_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(0, 40);
  return buffer;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startServer(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("MiMo service maps the companion TTS contract to the OpenAI-compatible API", async () => {
  const audio = wavBytes();
  let captured = null;
  const upstream = createServer(async (req, res) => {
    captured = {
      url: req.url,
      authorization: req.headers.authorization,
      body: await readJson(req),
    };
    const body = JSON.stringify({
      choices: [{ message: { audio: { data: audio.toString("base64") } } }],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  const upstreamPort = await startServer(upstream);
  const { server: service } = createMimoServer({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    voice: "冰糖",
    style: "温柔",
    fetchImpl: fetch,
    envFile: false,
  });
  const servicePort = await startServer(service);
  const base = `http://127.0.0.1:${servicePort}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.model, "mimo-v2.5-tts");
    assert.equal(health.keyConfigured, true);

    const voices = await (await fetch(`${base}/voices?locale=zh-CN`)).json();
    assert.equal(voices.ok, true);
    assert.equal(voices.count, 4);
    assert.ok(voices.voices.some((voice) => voice.shortName === "冰糖"));

    const response = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好，我是大肥鱼。", voice: "auto", style: "开心一点" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.equal(response.headers.get("x-tts-provider"), "mimo");
    assert.equal(decodeURIComponent(response.headers.get("x-voice")), "冰糖");
    const returned = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(returned, audio);

    assert.equal(captured.url, "/v1/chat/completions");
    assert.equal(captured.authorization, "Bearer test-key");
    assert.equal(captured.body.model, "mimo-v2.5-tts");
    assert.deepEqual(captured.body.messages, [
      { role: "user", content: "开心一点" },
      { role: "assistant", content: "你好，我是大肥鱼。" },
    ]);
    assert.deepEqual(captured.body.audio, { format: "wav", voice: "冰糖" });
  } finally {
    await closeServer(service);
    await closeServer(upstream);
  }
});

test("unknown MiMo voices are rejected before the network call", async () => {
  const { server } = createMimoServer({
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:1/v1",
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
    envFile: false,
  });
  const port = await startServer(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好", voice: "not-a-voice" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /unknown MiMo voice/);
    assert.match(body.error, new RegExp(MIMO_VOICES[0].shortName));
  } finally {
    await closeServer(server);
  }
});

test("missing MIMO_API_KEY yields a clear 503", async () => {
  const { server } = createMimoServer({
    apiKey: "",
    envFile: false,
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });
  const port = await startServer(server);
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.keyConfigured, false);
    const response = await fetch(`http://127.0.0.1:${port}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /MIMO_API_KEY/);
  } finally {
    await closeServer(server);
  }
});

test("upstream failures are reported as 502 without leaking the key", async () => {
  const { server } = createMimoServer({
    apiKey: "secret-key",
    baseUrl: "http://127.0.0.1:1/v1",
    fetchImpl: async () => new Response("quota exceeded", { status: 429 }),
    envFile: false,
  });
  const port = await startServer(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /HTTP 429/);
    assert.doesNotMatch(body.error, /secret-key/);
  } finally {
    await closeServer(server);
  }
});
