/**
 * Small local sidecar supervisor shared by companion-tts / companion-asr.
 *
 * It deliberately owns only process plumbing: spawn, health probe, external
 * detection, status and restart. Voice routing stays in each plugin.
 */

import { execFileSync, spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setState(states, name, patch) {
  states.set(name, { ...(states.get(name) ?? { name }), ...patch, at: Date.now() });
}

async function healthy(spec, timeoutMs = 2_500) {
  try {
    const response = await fetch(spec.healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}



export function createServiceManager(specs) {
  const states = new Map(specs.map((spec) => [spec.name, {
    name: spec.name,
    url: spec.healthUrl,
    external: false,
    pid: null,
    message: null,
    state: "idle",
    at: Date.now(),
  }]));
  const children = new Map();
  const specByName = new Map(specs.map((spec) => [spec.name, spec]));

  async function ensure(name, { force = false, timeoutMs = 30_000 } = {}) {
    const spec = specByName.get(name);
    if (!spec) throw new Error(`unknown service ${name}`);
    if (force) {
      const child = children.get(name);
      if (!child) {
        // Never kill an external listener: lsof also reports clients connected
        // to the port, and the DSH Host itself may hold such a connection.
        if (await healthy(spec)) {
          setState(states, name, {
            state: "up",
            external: true,
            pid: null,
            message: "external service; not restarted automatically",
          });
          return states.get(name);
        }
        // The port is free and we own no child: fall through and start one.
      } else {
        try { child.kill("SIGTERM"); } catch {}
        children.delete(name);
        setState(states, name, { state: "starting", external: false, pid: null, message: "restarting" });
        await sleep(600);
      }
    }
    const existing = children.get(name);
    if (existing && existing.exitCode === null) {
      if (await healthy(spec)) {
        setState(states, name, { state: "up", pid: existing.pid ?? null, external: false, message: null });
        return states.get(name);
      }
    }
    if (await healthy(spec)) {
      setState(states, name, { state: "up", external: true, pid: null, message: null });
      return states.get(name);
    }
    setState(states, name, { state: "starting", external: false, pid: null, message: null });
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...(spec.env ?? {}) },
      stdio: "ignore",
    });
    children.set(name, child);
    setState(states, name, { state: "starting", pid: child.pid ?? null, external: false, message: null });
    child.once("error", (error) => {
      setState(states, name, { state: "error", message: String(error?.message ?? error), pid: child.pid ?? null });
    });
    child.once("exit", (code, signal) => {
      if (states.get(name)?.state === "starting") {
        setState(states, name, { state: "error", message: `exited ${code ?? signal}`, pid: child.pid ?? null });
      }
      if (children.get(name) === child) children.delete(name);
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      if (await healthy(spec)) {
        setState(states, name, { state: "up", pid: child.pid ?? null, external: false, message: null });
        return states.get(name);
      }
      if (child.exitCode !== null) break;
    }
    setState(states, name, {
      state: "error",
      message: states.get(name)?.message ?? "health check timed out",
      pid: child.pid ?? null,
      external: false,
    });
    return states.get(name);
  }

  async function ensureAll() {
    await Promise.all(specs.map((spec) => ensure(spec.name)));
    return snapshot();
  }

  function snapshot() {
    return Object.fromEntries([...states.entries()].map(([name, state]) => [name, { ...state }]));
  }

  async function restart(name) {
    const names = name ? [name] : specs.map((spec) => spec.name);
    for (const item of names) {
      if (!specByName.has(item)) throw new Error(`unknown service ${item}`);
    }
    await Promise.all(names.map((item) => ensure(item, { force: true })));
    return snapshot();
  }

  return { ensure, ensureAll, snapshot, restart };
}
