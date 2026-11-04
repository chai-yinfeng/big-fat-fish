import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";

const edgeDir = path.resolve(import.meta.dirname, "../edge-tts");
const runScript = path.join(edgeDir, "run.sh");
const venvPython = path.join(edgeDir, ".venv", "bin", "python");
const uvAvailable = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
const skip = !existsSync(runScript)
  ? "edge-tts run.sh is missing"
  : !existsSync(venvPython)
    ? "edge-tts venv is missing (run: cd tts/edge-tts && uv sync --frozen)"
    : !uvAvailable
      ? "uv is not installed"
      : false;

function waitForPort(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`edge-tts did not print a port. stderr: ${stderr.slice(-1000)}`));
    }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/EDGE_TTS_PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`edge-tts exited before listening (code ${code}). stderr: ${stderr.slice(-1000)}`));
    });
  });
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`edge-tts health check timed out: ${lastError?.message ?? "unknown"}`);
}

test("standalone edge-tts service synthesizes Chinese MP3", { skip, timeout: 120_000 }, async () => {
  const child = spawn(runScript, ["--port", "0"], {
    cwd: edgeDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR || path.join(edgeDir, ".uv-cache"),
    },
  });
  try {
    const port = await waitForPort(child);
    const base = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(base);
    assert.equal(health.ok, true);
    assert.equal(health.service, "edge-tts");

    const voicesResponse = await fetch(`${base}/voices?locale=zh-CN`);
    assert.equal(voicesResponse.status, 200);
    const voices = await voicesResponse.json();
    assert.equal(voices.ok, true);
    assert.ok(voices.count > 0, "expected at least one zh-CN voice");
    assert.ok(voices.voices.some((voice) => voice.shortName === "zh-CN-XiaoxiaoNeural"));

    const ttsResponse = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "你好，我是大肥鱼。",
        voice: "zh-CN-XiaoxiaoNeural",
      }),
    });
    assert.equal(ttsResponse.status, 200);
    assert.match(ttsResponse.headers.get("content-type") ?? "", /audio\/mpeg/);
    assert.equal(ttsResponse.headers.get("x-voice"), "zh-CN-XiaoxiaoNeural");
    const audio = new Uint8Array(await ttsResponse.arrayBuffer());
    assert.ok(audio.byteLength > 1000, `expected real MP3 bytes, got ${audio.byteLength}`);
    const header = audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33
      ? "ID3"
      : `${audio[0].toString(16)} ${audio[1].toString(16)}`;
    assert.ok(
      header === "ID3" || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0),
      `unexpected MP3 header: ${header}`,
    );

    const badResponse = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    assert.equal(badResponse.status, 400);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
