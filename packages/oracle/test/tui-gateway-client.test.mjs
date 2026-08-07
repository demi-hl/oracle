import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { createGatewayClient } from "../src/tui/gateway-client.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.writes = [];
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      child.writes.push(chunk.toString());
      callback();
    },
  });
  child.killCount = 0;
  child.kill = () => {
    child.killCount += 1;
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    return true;
  };
  return child;
}

function setup(options = {}) {
  const child = fakeChild();
  const calls = [];
  const client = createGatewayClient({
    python: "/fake/python",
    cwd: "/fake/hermes",
    env: { TESTING: "1" },
    startupTimeoutMs: 50,
    requestTimeoutMs: 50,
    spawnFn(command, args, spawnOptions) {
      calls.push({ command, args, spawnOptions });
      return child;
    },
    ...options,
  });
  return { child, client, calls };
}

function nextEvent(client, event) {
  return new Promise((resolve) => {
    const listener = (...args) => {
      client.off(event, listener);
      resolve(args);
    };
    client.on(event, listener);
  });
}

async function startClient(client, child) {
  const started = client.start();
  child.stdout.write('{"method":"ready"}\n');
  await started;
}

test("start resolves after the first parsed line", async () => {
  const { child, client, calls } = setup();
  const started = client.start();
  child.stdout.write('{"method":"ready"}\n');
  await started;
  assert.deepEqual(calls, [{
    command: "/fake/python",
    args: ["-m", "tui_gateway.entry"],
    spawnOptions: { cwd: "/fake/hermes", env: { TESTING: "1" } },
  }]);
});

test("start passes python shebang prefix args", async () => {
  const { child, client, calls } = setup({ python: "/usr/bin/env", pythonArgs: ["python3"] });
  const started = client.start();
  child.stdout.write('{"method":"ready"}\n');
  await started;
  assert.equal(calls[0].command, "/usr/bin/env");
  assert.deepEqual(calls[0].args, ["python3", "-m", "tui_gateway.entry"]);
});

test("start rejects on a child spawn error", async () => {
  const { child, client } = setup();
  const started = client.start();
  child.emit("error", new Error("spawn failed"));
  await assert.rejects(started, /spawn failed/);
});

test("start rejects on timeout", async () => {
  const { client } = setup({ startupTimeoutMs: 5 });
  await assert.rejects(client.start(), /startup timed out/);
});

test("request round trip resolves with the result", async () => {
  const { child, client } = setup();
  await startClient(client, child);
  const response = client.request("prompt.submit", { text: "hello" });
  assert.deepEqual(JSON.parse(child.writes[0]), {
    id: 1,
    method: "prompt.submit",
    params: { text: "hello" },
  });
  child.stdout.write('{"id":1,"result":{"ok":true}}\n');
  assert.deepEqual(await response, { ok: true });
});

test("request rejects with the gateway error payload", async () => {
  const { child, client } = setup();
  await startClient(client, child);
  const response = client.request("bad.method", {});
  child.stdout.write('{"id":1,"error":{"code":9,"message":"denied"}}\n');
  await assert.rejects(response, (error) => {
    assert.equal(error.message, "denied");
    assert.deepEqual(error.error, { code: 9, message: "denied" });
    return true;
  });
});

test("request rejects on timeout", async () => {
  const { child, client } = setup({ requestTimeoutMs: 5 });
  await startClient(client, child);
  await assert.rejects(client.request("slow", {}), /request 1 timed out/);
});

test("a malformed line surfaces as a log and parsing continues", async () => {
  const { child, client } = setup();
  const logs = [];
  client.on("log", (line) => logs.push(line));
  const started = client.start();
  child.stdout.write("not json\n");
  child.stdout.write('{"method":"ready"}\n');
  await started;
  assert.deepEqual(logs, ["not json"]);
});

test("a response with an unknown id is ignored", async () => {
  const { child, client } = setup();
  await startClient(client, child);
  child.stdout.write('{"id":999,"result":"unused"}\n');
  const response = client.request("known", {});
  child.stdout.write('{"id":1,"result":"used"}\n');
  assert.equal(await response, "used");
});

test("child exit rejects all in flight requests", async () => {
  const { child, client } = setup();
  await startClient(client, child);
  const first = client.request("one", {});
  const second = client.request("two", {});
  child.emit("exit", 7, null);
  await assert.rejects(first, /exited.*7/);
  await assert.rejects(second, /exited.*7/);
});

test("an idless line emits an event", async () => {
  const { child, client } = setup();
  const event = nextEvent(client, "event");
  const started = client.start();
  child.stdout.write('{"method":"ready","params":{"version":1}}\n');
  await started;
  assert.deepEqual(await event, [{ method: "ready", params: { version: 1 } }]);
});

test("each stderr line emits a log", async () => {
  const { child, client } = setup();
  const logs = [];
  client.on("log", (line) => logs.push(line));
  await startClient(client, child);
  child.stderr.write("first\nsecond\n");
  assert.deepEqual(logs, ["first", "second"]);
});

test("long stderr lines are truncated with a byte count", async () => {
  const { child, client } = setup();
  const logged = nextEvent(client, "log");
  await startClient(client, child);
  child.stderr.write(`${"x".repeat(4100)}\n`);
  const [line] = await logged;
  assert.equal(line, `${"x".repeat(4096)} ... [truncated 4 bytes]`);
});

test("stop rejects pending requests and is idempotent", async () => {
  const { child, client } = setup();
  await startClient(client, child);
  const response = client.request("pending", {});
  const stopped = client.stop();
  await assert.rejects(response, /stopped.*pending/);
  await stopped;
  await client.stop();
  assert.equal(child.killCount, 1);
});
