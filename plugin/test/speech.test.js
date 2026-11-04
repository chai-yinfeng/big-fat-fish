import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSpeechService,
  playerCommand,
  ttsUrls,
} from "../lib/speech.js";
import { toAutoSpeechText, toSpeechText } from "../lib/session.js";

test("TTS URLs use the adapter route first and edge as fallback", () => {
  assert.deepEqual(
    ttsUrls({ useAdapter: true }, () => "http://127.0.0.1:60619"),
    ["http://127.0.0.1:60619/companion/tts", "http://127.0.0.1:9003/tts"],
  );
  assert.deepEqual(
    ttsUrls({ useAdapter: false }, () => "http://127.0.0.1:60619"),
    ["http://127.0.0.1:9003/tts"],
  );
  assert.deepEqual(
    ttsUrls({ urls: ["http://custom/tts"] }, () => {
      throw new Error("no origin");
    }),
    ["http://custom/tts"],
  );
});

test("player selection follows the platform and explicit config", () => {
  assert.equal(playerCommand("auto", "darwin").command, "afplay");
  assert.equal(playerCommand("auto", "linux").command, "ffplay");
  assert.equal(playerCommand("mpv", "linux").command, "mpv");
  assert.equal(playerCommand("/usr/local/bin/my-player", "linux").command, "/usr/local/bin/my-player");
  assert.deepEqual(playerCommand("ffplay").args("/tmp/a.mp3"), ["-nodisp", "-autoexit", "-loglevel", "quiet", "/tmp/a.mp3"]);
});

test("speech text drops code, URLs and markup", () => {
  const text = toSpeechText("## 标题\n看这个 [链接](https://example.com) 和 `代码`\n```js\nconsole.log(1)\n```\n正文。", 100);
  assert.equal(text, "标题 看这个 链接 和 代码 正文。");
  assert.equal(toSpeechText("```js\nconsole.log(1)\n```", 100), "");
  assert.match(toSpeechText("这是一段很长的话", 5), /…$/);
});

function fakeSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = (signal) => {
      calls.push({ killed: signal });
    };
    setTimeout(() => child.emit("exit", 0, null), 0);
    return child;
  };
}

function audioResponse(bytes = [1, 2, 3], headers = { "content-type": "audio/mpeg" }) {
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

test("synthesize falls back to the next endpoint and returns bytes", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith("http://bad/")) throw new Error("connection refused");
    return audioResponse();
  };
  const service = createSpeechService({
    config: { urls: ["http://bad/tts", "http://good/tts"], voice: "v1", timeoutMs: 5_000 },
    fetchImpl,
  });
  const result = await service.synthesize("你好");
  assert.deepEqual([...result.audio], [1, 2, 3]);
  assert.equal(result.url, "http://good/tts");
  assert.deepEqual(calls, ["http://bad/tts", "http://good/tts"]);
});

test("synthesize reports every endpoint failure", async () => {
  const service = createSpeechService({
    config: { urls: ["http://a/tts", "http://b/tts"] },
    fetchImpl: async (url) => new Response("nope", { status: 503 }),
  });
  await assert.rejects(() => service.synthesize("你好"), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /http:\/\/a\/tts HTTP 503/);
    assert.match(error.message, /http:\/\/b\/tts HTTP 503/);
    return true;
  });
});

test("speak writes a temporary file, plays it and cleans up", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "companion-speech-"));
  const calls = [];
  const service = createSpeechService({
    config: { urls: ["http://good/tts"], voice: "v1", player: "auto", maxChars: 100 },
    cacheDir: dir,
    fetchImpl: async () => audioResponse([9, 8, 7]),
    spawnImpl: fakeSpawn(calls),
    platform: "darwin",
  });
  const result = await service.speak("你好，大肥鱼。");
  assert.equal(result.chars, 7);
  assert.equal(result.bytes, 3);
  assert.equal(result.player, "afplay");
  assert.equal(calls[0].command, "afplay");
  assert.equal(calls[0].args.length, 1);
  assert.match(calls[0].args[0], /tts-.*\.mp3$/);
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("speak rejects text with nothing speakable", async () => {
  const service = createSpeechService({
    config: { urls: ["http://good/tts"] },
    fetchImpl: async () => audioResponse(),
  });
  await assert.rejects(() => service.speak("```js\nconsole.log(1)\n```"), /nothing speakable/);
});

test("play failure reports the player exit code", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "companion-speech-fail-"));
  const service = createSpeechService({
    config: { urls: ["http://good/tts"], player: "afplay" },
    cacheDir: dir,
    fetchImpl: async () => audioResponse(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.kill = () => {};
      setTimeout(() => child.emit("exit", 2, null), 0);
      return child;
    },
    platform: "darwin",
  });
  await assert.rejects(() => service.speak("你好"), /exited with code 2/);
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test("stopping a playback is treated as an interruption, not a failure", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "companion-speech-stop-"));
  const service = createSpeechService({
    config: { urls: ["http://good/tts"], player: "afplay" },
    cacheDir: dir,
    fetchImpl: async () => audioResponse(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.kill = () => {
        setTimeout(() => child.emit("exit", null, "SIGTERM"), 0);
      };
      return child;
    },
    platform: "darwin",
  });
  const playing = service.play(new Uint8Array([1, 2, 3]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  service.stop();
  await playing;
  assert.equal(service.playing, false);
  rmSync(dir, { recursive: true, force: true });
});

test("auto speech keeps complete opening sentences", () => {
  const text = "第一句话很短。第二句话稍微长一点，但还是会保留。第三句很长很长。";
  assert.equal(toAutoSpeechText(text, 20), "第一句话很短。");
  assert.equal(toAutoSpeechText("没有标点的一段话继续继续继续", 6), "没有标点的…");
  assert.equal(toAutoSpeechText("```js\nconsole.log(1)\n```", 20), "");
});

test("autoSpeak modes skip or shorten long replies", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "companion-auto-speech-"));
  const calls = [];
  const config = {
    urls: ["http://good/tts"],
    voice: "auto",
    style: "温柔",
    player: "afplay",
    autoSpeakMaxChars: 10,
  };
  const service = createSpeechService({
    config: { ...config, autoSpeakMode: "first-sentences" },
    cacheDir: dir,
    fetchImpl: async () => audioResponse([1, 2, 3]),
    spawnImpl: fakeSpawn(calls),
    platform: "darwin",
  });
  const shortened = await service.autoSpeak("好的，我记住了。这是一段很长的解释，不会被念出来。");
  assert.equal(shortened.text, "好的，我记住了。");

  const skipped = createSpeechService({
    config: { ...config, autoSpeakMode: "short-only", autoSpeakMaxChars: 5 },
    cacheDir: dir,
    fetchImpl: async () => {
      throw new Error("short-only must not synthesize");
    },
    spawnImpl: fakeSpawn(calls),
    platform: "darwin",
  });
  assert.equal(await skipped.autoSpeak("这是一段很长的回复。"), null);

  const off = createSpeechService({
    config: { ...config, autoSpeakMode: "off" },
    cacheDir: dir,
    fetchImpl: async () => {
      throw new Error("off must not synthesize");
    },
    spawnImpl: fakeSpawn(calls),
    platform: "darwin",
  });
  assert.equal(await off.autoSpeak("你好"), null);
  rmSync(dir, { recursive: true, force: true });
});
