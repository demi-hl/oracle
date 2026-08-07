import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createOracleTui, runOracleTui } from "../src/tui/app.mjs";
import { createPalette } from "../src/tui/theme.mjs";

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.requests = [];
    this.started = false;
    this.stopped = false;
  }

  async start() {
    this.started = true;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "session.create") {
      return { session_id: "sid1", info: { model: "claude-opus-5", context_length: 200000 } };
    }
    return { ok: true };
  }

  async stop() {
    this.stopped = true;
  }
}

function fakeRenderer() {
  return {
    renders: [],
    above: [],
    disposed: false,
    render(lines) {
      this.renders.push([...lines]);
    },
    writeAbove(text) {
      this.above.push(text);
    },
    clear() {
      this.cleared = true;
    },
    dispose() {
      this.disposed = true;
    },
  };
}

test("createOracleTui starts a gateway session and paints oracle chrome", async () => {
  const client = new FakeClient();
  const renderer = fakeRenderer();
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.isTTY = false;
  const tui = createOracleTui({ client, renderer, stdin, stdout, palette: createPalette({ color: false }) });

  await tui.start();

  assert.equal(client.started, true);
  assert.deepEqual(client.requests[0], {
    method: "session.create",
    params: { cols: 80, cwd: process.cwd(), source: "cli", profile: "oracle", close_on_disconnect: true },
  });
  assert.equal(tui.state.sessionId, "sid1");
  assert.equal(tui.state.model, "claude-opus-5");
  assert.ok(renderer.above.join("\n").includes("THE FUTURE IS AGENTIC"));
  assert.ok(renderer.renders.at(-1).some((line) => line.includes("Ask Oracle")));

  await tui.stop();
  assert.equal(client.stopped, true);
  assert.equal(renderer.disposed, true);
});

test("gateway message events stream above the fixed prompt region", async () => {
  const client = new FakeClient();
  const renderer = fakeRenderer();
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.isTTY = false;
  const tui = createOracleTui({ client, renderer, stdin, stdout, palette: createPalette({ color: false }) });
  await tui.start();

  client.emit("event", { params: { type: "message.start", session_id: "sid1" } });
  client.emit("event", { params: { type: "message.delta", session_id: "sid1", payload: { text: "hello" } } });
  client.emit("event", { params: { type: "message.complete", session_id: "sid1", payload: { usage: { context_tokens: 1000, context_length: 2000 } } } });

  assert.equal(tui.state.busy, false);
  assert.equal(tui.state.contextPercent, 50);
  assert.ok(renderer.above.join("").includes("oracle"));
  assert.ok(renderer.above.join("").includes("hello"));
  await tui.stop();
});

test("runOracleTui falls back for one shot queries", async () => {
  const result = await runOracleTui({ hermesPython: { command: "python" }, args: ["-q", "hi"], stdin: {}, stdout: {} });
  assert.equal(result.native, false);
  assert.deepEqual(result.pass, ["-q", "hi"]);
});

test("streamed deltas join into whole lines instead of one line per chunk", async () => {
  const client = new FakeClient();
  const renderer = fakeRenderer();
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.isTTY = false;
  const tui = createOracleTui({ client, renderer, stdin, stdout, palette: createPalette({ color: false }) });
  await tui.start();
  renderer.above.length = 0;

  const emit = (type, payload) => client.emit("event", { params: { type, session_id: "sid1", payload } });
  emit("message.start", {});
  // A word arriving as several deltas must NOT become several lines.
  for (const piece of ["P", "O", "N", "G", " the", " end"]) emit("message.delta", { text: piece });
  emit("message.complete", { text: "PONG the end", usage: {} });

  const printed = renderer.above.join("").split("\n").map((l) => l.trim()).filter(Boolean);
  assert.ok(printed.includes("PONG the end"), `expected one joined line, got ${JSON.stringify(printed)}`);
  assert.equal(printed.filter((l) => l === "P").length, 0, "single chars must not be their own lines");
  await tui.stop();
});

test("multi-line replies flush each newline exactly once", async () => {
  const client = new FakeClient();
  const renderer = fakeRenderer();
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.isTTY = false;
  const tui = createOracleTui({ client, renderer, stdin, stdout, palette: createPalette({ color: false }) });
  await tui.start();
  renderer.above.length = 0;

  const emit = (type, payload) => client.emit("event", { params: { type, session_id: "sid1", payload } });
  emit("message.start", {});
  emit("message.delta", { text: "one\ntw" });
  emit("message.delta", { text: "o\nthree" });
  emit("message.complete", { text: "one\ntwo\nthree", usage: {} });

  const printed = renderer.above.join("").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const want of ["one", "two", "three"]) {
    assert.equal(printed.filter((l) => l === want).length, 1, `"${want}" should appear exactly once`);
  }
  await tui.stop();
});

test("interrupt stops the stream and drops late deltas", async () => {
  const client = new FakeClient();
  const renderer = fakeRenderer();
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const stdout = new PassThrough();
  stdout.columns = 100;
  stdout.isTTY = false;
  const tui = createOracleTui({ client, renderer, stdin, stdout, palette: createPalette({ color: false }) });
  await tui.start();

  const emit = (type, payload) => client.emit("event", { params: { type, session_id: "sid1", payload } });
  emit("message.start", {});
  emit("message.delta", { text: "partial" });

  tui.state.busy = true;
  stdin.write("\u0003");
  await new Promise((resolve) => setImmediate(resolve));

  renderer.above.length = 0;
  emit("message.delta", { text: "SHOULD_NOT_APPEAR" });
  emit("message.complete", { text: "SHOULD_NOT_APPEAR", usage: {} });

  assert.equal(tui.state.busy, false);
  assert.ok(
    !renderer.above.join("").includes("SHOULD_NOT_APPEAR"),
    "post-interrupt deltas must be discarded",
  );
  assert.ok(
    client.requests.some((r) => r.method === "session.interrupt"),
    "ctrl+c must ask the gateway to interrupt the turn",
  );
  await tui.stop();
});

test("usage maps real gateway field names onto the status bar", async () => {
  const client = new FakeClient();
  const renderer = fakeRenderer();
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.isTTY = false;
  const tui = createOracleTui({ client, renderer, stdin, stdout, palette: createPalette({ color: false }) });
  await tui.start();

  // Shape captured from a real hermes tui_gateway message.complete frame.
  client.emit("event", {
    params: {
      type: "message.complete",
      session_id: "sid1",
      payload: { text: "ok", usage: { context_used: 30086, context_max: 272000, context_percent: 11 } },
    },
  });

  assert.equal(tui.state.contextTokens, 30086);
  assert.equal(tui.state.contextLength, 272000);
  assert.equal(tui.state.contextPercent, 11);
  const bar = tui.state.palette ? renderer.renders.at(-1).at(-1) : "";
  assert.ok(bar.includes("30K/272K"), `status bar missing token counts: ${bar}`);
  await tui.stop();
});

test("session.info carries the reasoning effort into the status bar", async () => {
  const client = new FakeClient();
  const renderer = fakeRenderer();
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.isTTY = false;
  const tui = createOracleTui({ client, renderer, stdin, stdout, palette: createPalette({ color: false }) });
  await tui.start();

  client.emit("event", {
    params: {
      type: "session.info",
      session_id: "sid1",
      payload: { model: "gpt-5.5", reasoning_effort: "xhigh" },
    },
  });

  assert.equal(tui.state.model, "gpt-5.5");
  assert.equal(tui.state.effort, "xhigh");
  assert.ok(renderer.renders.at(-1).at(-1).includes("xhigh"));
  await tui.stop();
});

test("runOracleTui keeps an explicit native TUI opt out", async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  const result = await runOracleTui({
    hermesPython: { command: "python" },
    args: [],
    stdin,
    stdout,
    env: { ORACLE_NATIVE_TUI: "0" },
  });
  assert.equal(result.native, false);
  assert.deepEqual(result.pass, []);
});

test("runOracleTui launches an injected standalone client without Python", async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  const client = new FakeClient();
  const calls = [];
  const result = await runOracleTui({
    client,
    args: [],
    stdin,
    stdout,
    env: {},
    tuiFactory(options) {
      calls.push(options);
      const emitter = new EventEmitter();
      return {
        on: emitter.on.bind(emitter),
        async start() { setImmediate(() => emitter.emit("stop")); },
        async stop() {},
      };
    },
  });

  assert.equal(result.native, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].client, client);
  assert.equal(calls[0].python, undefined);
});
