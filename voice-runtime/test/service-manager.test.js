import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createServiceManager } from "../service-manager.js";

async function healthServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port };
}

test("healthy external listeners are adopted and never killed", async () => {
  const { server, port } = await healthServer();
  const manager = createServiceManager([{
    name: "external-test",
    cwd: process.cwd(),
    command: "/definitely/not/a/real/command",
    args: [],
    healthUrl: `http://127.0.0.1:${port}/health`,
  }]);
  try {
    const first = await manager.ensure("external-test");
    assert.equal(first.state, "up");
    assert.equal(first.external, true);
    const restarted = await manager.restart("external-test");
    assert.equal(restarted["external-test"].state, "up");
    assert.equal(restarted["external-test"].external, true);
    assert.equal(server.listening, true);
  } finally {
    server.close();
  }
});
