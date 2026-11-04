import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { FileJournal } from "../../core/src/journal.js";

const SESSION_ID = "session-shell-test";

function makeResponse() {
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

function makeLlm(text) {
  const calls = [];
  return {
    calls,
    async *stream(options) {
      calls.push(options);
      yield { type: "text-delta", index: 0, text };
      yield { type: "finish", reason: { kind: "stop" } };
    },
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: "low" }, { id: "high" }] } };
    },
  };
}

function extractionJson() {
  return JSON.stringify({
    facts: [{ subject: "用户", key: "喜欢的咖啡", value: "耶加雪菲", confidence: 0.9 }],
    diary: [
      { kind: "outer", text: "今天聊了手冲咖啡。" },
      { kind: "inner", text: "我觉得他今天心情不错。" },
    ],
    episodes: [{ summary: "聊了耶加雪菲手冲", salience: 0.7, emotions: { joy: 0.6 } }],
    moodEvent: "share",
  });
}

async function waitFor(check, timeoutMs = 3000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timed out waiting for condition");
}

test("companion plugin binds a session, injects context, extracts memory and serves routes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "companion-shell-"));
  fs.mkdirSync(path.join(home, "companion"), { recursive: true });
  fs.writeFileSync(path.join(home, "companion", "config.json"), JSON.stringify({
    targetSession: "",
    presence: "unknown",
    budgetChars: 1200,
    tickMs: 60_000,
    extractor: { enabled: true, debounceMs: 250, maxTurns: 6, maxTokens: 500 },
    diary: { maxOuterPerDay: 1, maxInnerPerDay: 1, window: { enabled: false } },
    innerDiary: { enabled: false },
    services: { autoStart: false },
    tts: {
      enabled: true,
      autoSpeak: false,
      urls: ["http://tts.test/tts"],
      voice: "test-voice",
      player: "true",
    },
  }));
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const llm = makeLlm(extractionJson());
  const originalFetch = globalThis.fetch;
  const ttsCalls = [];
  globalThis.fetch = async (url) => {
    ttsCalls.push(String(url));
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "audio/mpeg", "x-tts-provider": "fake" },
    });
  };

  const handlers = new Map();
  const routes = new Map();
  const contexts = [];
  const commands = [];
  const intervals = [];
  const disposers = [];
  const provided = {};
  const sent = [];
  const events = [];

  const agent = {
    session: {
      id: SESSION_ID,
      snapshotEvents: () => events,
      requestHeader: () => ({ config: { provider: "fake", model: "fake-1" } }),
    },
    options: { provider: "fake", model: "fake-1" },
    status: "idle",
    followup(message) {
      sent.push(message);
    },
  };

  const extraAgents = [];

  const services = {
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: "fake", model: "fake-2" }) },
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      },
    },
  };

  const ctx = {
    get(name) {
      return services[name];
    },
    provide(name, value) {
      provided[name] = value;
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") disposers.push(disposer);
      return disposer;
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    interval(fn, delay) {
      intervals.push({ fn, delay });
      return () => {};
    },
    agents: {
      list: () => [agent, ...extraAgents],
      get: (id) => (id === SESSION_ID
        ? agent
        : extraAgents.find((candidate) => candidate.session.id === id)),
    },
    systemPrompt: {
      context(options) {
        contexts.push(options);
        return () => {};
      },
      getContextOrder() {
        return 210;
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
      getOrigin() {
        return "http://127.0.0.1:65535";
      },
    },
  };

  async function callRoute(method, url, body) {
    const route = routes.get(url.split("?")[0]);
    assert.ok(route, `route ${url} is registered`);
    const res = makeResponse();
    await route.handler(request(method, url, body), res);
    let json = null;
    const contentType = res.headers["content-type"] ?? "";
    if (contentType.includes("application/json") && res.body) {
      json = JSON.parse(res.body.toString("utf8"));
    }
    return { status: res.statusCode, headers: res.headers, json, body: res.body };
  }

  function emitSessionEvent(type, data, seq) {
    const event = { type, seq, time: Date.now(), data };
    events.push(event);
    handlers.get("session/event")?.(agent.session, event);
  }

  const plugin = await import("../lib/index.js");
  try {
    plugin.apply(ctx, undefined, { openJournal: (file) => new FileJournal(file) });
    await waitFor(() => routes.has("/companion-core/state"));
    await waitFor(async () => (await callRoute("GET", "/companion-core/state")).json?.ready);

    // Unbound: no context contribution, no bound session.
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].text({ agent }), "");
    let state = (await callRoute("GET", "/companion-core/state")).json;
    assert.equal(state.bound, null);
    assert.equal(state.counts.facts, 0);
    assert.equal(state.services.edge.state, "disabled");
    assert.equal(state.services.mimo.state, "disabled");
    assert.equal(state.services.qwen.state, "disabled");
    assert.equal(state.services.minimax.state, "disabled");
    assert.equal(state.services.asr.state, "disabled");

    // Bind through the admin route used by the command as well.
    const bound = await callRoute("POST", "/companion-core/bind", { sessionId: SESSION_ID });
    assert.equal(bound.status, 200);
    assert.equal(bound.json.bound, SESSION_ID);
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.equal(state.bound, SESSION_ID);
    const config = JSON.parse(fs.readFileSync(path.join(home, "companion", "config.json"), "utf8"));
    assert.equal(config.targetSession, SESSION_ID);
    assert.match(contexts[0].text({ agent }), /【人格】/);
    assert.match(contexts[0].text({ agent }), /关系与心情/);
    assert.equal(state.apiVersion, 1);
    assert.equal(state.capabilities.voiceInput, true);
    assert.equal(state.capabilities.asr, false);
    assert.equal(state.persona.revision, 1);
    assert.equal(state.persona.source, "persona.json");
    const personaFile = path.join(home, "companion", "persona.json");
    const personaDocument = JSON.parse(fs.readFileSync(personaFile, "utf8"));
    personaDocument.revision = 2;
    personaDocument.persona.name = "独立测试伙伴";
    fs.writeFileSync(personaFile, JSON.stringify(personaDocument));
    assert.equal((await commands[0].handler({ rawInput: "persona reload", agent })).kind, "success");
    assert.match(contexts[0].text({ agent }), /独立测试伙伴/);
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.equal(state.persona.revision, 2);
    assert.equal(state.persona.sourceError, null);
    fs.writeFileSync(personaFile, JSON.stringify({ ...personaDocument, persona: { ...personaDocument.persona, name: "未升级版本" } }));
    assert.equal((await commands[0].handler({ rawInput: "persona reload", agent })).kind, "error");
    assert.match(contexts[0].text({ agent }), /独立测试伙伴/);
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.ok(state.persona.sourceError);
    fs.writeFileSync(personaFile, JSON.stringify(personaDocument));
    provided.companion.reloadPersona();
    assert.equal(provided.companion.state().persona.sourceError, null);

    const configRes = await callRoute("POST", "/companion-core/config", {
      tts: { voice: "冰糖", autoSpeakMode: "short-only", autoSpeakMaxChars: 60 },
    });
    assert.equal(configRes.status, 200);
    assert.equal(configRes.json.tts.voice, "冰糖");
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.equal(state.tts.voice, "冰糖");
    assert.equal(state.tts.autoSpeakMode, "short-only");

    const voiceRes = await callRoute("POST", "/companion-core/voice", { text: "语音转写测试" });
    assert.equal(voiceRes.status, 200);
    assert.equal(sent[0].source.kind, "user");
    assert.equal(sent[0].content[0].text, "语音转写测试");

    // One complete turn: user -> assistant -> turn-stopping.
    emitSessionEvent("turn/start", { turn: 1 }, 1);
    emitSessionEvent("user/message", {
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "我最近在学手冲，最喜欢耶加雪菲。" }],
      source: { kind: "user" },
    }, 2);
    emitSessionEvent("assistant/message", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "耶加雪菲的柑橘香很适合你。" }],
        source: { kind: "model", provider: "fake", model: "fake-1" },
      },
    }, 3);
    handlers.get("agent/turn-stopping")?.({ agent, turn: 1, signal: new AbortController().signal });

    await waitFor(async () => {
      const current = (await callRoute("GET", "/companion-core/state")).json;
      return current.counts.facts === 1;
    }, 5000);
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.equal(state.counts.facts, 1);
    assert.equal(state.counts.episodes, 1);
    assert.deepEqual(state.diaryToday, { outer: 1, inner: 0 });
    assert.equal(state.extractor.last.ok, true);
    assert.equal(state.extractor.last.route.provider, "fake");
    assert.ok(llm.calls.length >= 1);
    assert.match(contexts[0].text({ agent }), /耶加雪菲/);

    const journal = fs.readFileSync(path.join(home, "companion", "journal.jsonl"), "utf8");
    assert.match(journal, /"type":"fact\/added"/);
    assert.match(journal, /"type":"diary\/added"/);
    assert.match(journal, /"type":"episode\/added"/);

    // Legacy outer diary remains capped; the extractor never writes inner diary.
    emitSessionEvent("turn/start", { turn: 2 }, 4);
    emitSessionEvent("user/message", {
      id: "m2",
      role: "user",
      content: [{ type: "text", text: "今天又喝了一杯咖啡。" }],
      source: { kind: "user" },
    }, 5);
    emitSessionEvent("assistant/message", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "那今天很满足。" }],
        source: { kind: "model", provider: "fake", model: "fake-1" },
      },
    }, 6);
    handlers.get("agent/turn-stopping")?.({ agent, turn: 2, signal: new AbortController().signal });
    const firstAt = state.extractor.last.at;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await waitFor(async () => {
      const current = (await callRoute("GET", "/companion-core/state")).json;
      return current.extractor.last.at !== firstAt && current.extractor.extracting === false;
    }, 5000);
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.deepEqual(state.diaryToday, { outer: 1, inner: 0 });

    // Commands: bind/status/diary/pause/resume and inner privacy.
    const command = commands[0];
    assert.equal(command.name, "companion");
    const bindResult = await command.handler({ rawInput: "bind", agent });
    assert.equal(bindResult.kind, "success");
    const statusResult = await command.handler({ rawInput: "status", agent });
    assert.match(statusResult.text, /绑定会话/);
    assert.match(statusResult.text, /心情/);
    const diaryResult = await command.handler({ rawInput: "diary 5", agent });
    assert.match(diaryResult.text, /今天聊了手冲咖啡/);
    const innerResult = await command.handler({ rawInput: "diary inner", agent });
    assert.equal(innerResult.kind, "error");
    assert.match(innerResult.text, /inner/);
    const voiceResult = await command.handler({ rawInput: "voice auto", agent });
    assert.equal(voiceResult.kind, "success");
    const styleResult = await command.handler({ rawInput: "style 温柔一点", agent });
    assert.equal(styleResult.kind, "success");
    const autoResult = await command.handler({ rawInput: "autospeak first", agent });
    assert.equal(autoResult.kind, "success");
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.equal(state.tts.voice, "auto");
    assert.equal(state.tts.style, "温柔一点");
    assert.equal(state.tts.autoSpeakMode, "first-sentences");

    const pauseResult = await command.handler({ rawInput: "pause 30m", agent });
    assert.equal(pauseResult.kind, "success");
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.ok(state.pausedUntil > Date.now());
    const resumeResult = await command.handler({ rawInput: "resume", agent });
    assert.equal(resumeResult.kind, "success");
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.equal(state.pausedUntil, null);

    // Dry-run extraction through the admin route does not change the journal.
    const dry = await callRoute("POST", "/companion-core/extract", {
      dryRun: true,
      userText: "我喜欢浅烘的豆子。",
      assistantText: "浅烘的酸质更明亮。",
    });
    assert.equal(dry.status, 200);
    assert.equal(dry.json.dryRun, true);
    assert.equal(dry.json.extraction.facts.length, 1);

    // TTS synthesis without playback.
    const audio = await callRoute("POST", "/companion-core/speak", { text: "你好", play: false });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers["content-type"], "audio/mpeg");
    assert.deepEqual([...audio.body], [1, 2, 3]);
    assert.ok(ttsCalls.length >= 1);

    // Proactive delivery goes through agent.followup with our own source kind.
    const poke = await callRoute("POST", "/companion-core/poke", {});
    assert.equal(poke.status, 200);
    const proactive = sent.find((message) => message.source.kind === "plugin:companion-core");
    assert.ok(proactive);
    assert.match(proactive.content[0].text, /companion-core\/proactive/);
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.equal(state.interaction.unrespondedProactive, 1);

    // Inner diary is not exposed over HTTP.
    const innerRoute = await callRoute("GET", "/companion-core/diary?kind=inner");
    assert.equal(innerRoute.status, 403);

    // The companion service mirrors state for other plugins.
    assert.ok(provided.companion);
    assert.equal(provided.companion.state().bound, SESSION_ID);
    assert.throws(() => provided.companion.memory({ kind: "inner" }), /only outer/);

    // A second bound session shares the same companion state.
    const secondBind = await callRoute("POST", "/companion-core/bind", { sessionId: "session-extra" });
    assert.equal(secondBind.status, 200);
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.ok(state.boundSessions.includes(SESSION_ID));
    assert.ok(state.boundSessions.includes("session-extra"));

    // A session created with the companion agent preset auto-binds.
    await callRoute("POST", "/companion-core/unbind", {});
    const presetAgent = {
      session: {
        id: "session-companion-preset",
        header: {
          id: "session-companion-preset",
          agentPreset: "companion",
          isSeeded: false,
        },
        snapshotEvents: () => [],
        requestHeader: () => ({ config: { provider: "fake", model: "fake-1" } }),
      },
      options: { provider: "fake", model: "fake-1" },
      status: "idle",
      followup() {},
    };
    extraAgents.push(presetAgent);
    handlers.get("agent/created")?.({ agent: presetAgent, source: "startup" });
    state = (await callRoute("GET", "/companion-core/state")).json;
    assert.equal(state.bound, "session-companion-preset");
  } finally {
    for (const disposer of disposers.reverse()) {
      try {
        disposer();
      } catch {
        // Disposal order after the journal closes is allowed to be noisy.
      }
    }
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
