import assert from "node:assert/strict";
import test from "node:test";

import {
  createStandaloneClient,
  runOracleCommand,
} from "../src/tui/standalone-client.mjs";

const CONFIG = Object.freeze({
  kind: "standalone",
  provider: "openrouter",
  model: "openrouter/auto",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-key",
  contextLength: 128000,
  reasoningEffort: "high",
});

function sse(chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function waitForComplete(client) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message.complete timeout")), 500);
    client.on("event", (frame) => {
      if (frame?.params?.type !== "message.complete") return;
      clearTimeout(timer);
      resolve(frame.params.payload);
    });
  });
}

test("standalone client streams an Oracle turn without a Python gateway", async () => {
  const requests = [];
  const client = createStandaloneClient({
    config: CONFIG,
    persona: "You are Oracle.",
    fetchFn: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return sse([
        { choices: [{ delta: { content: "PO" }, finish_reason: null }] },
        { choices: [{ delta: { content: "NG" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 2 } },
      ]);
    },
  });

  await client.start();
  const session = await client.request("session.create", { source: "cli" });
  assert.equal(session.info.model, "openrouter/auto");
  assert.equal(session.info.reasoning_effort, "high");

  const events = [];
  client.on("event", (frame) => events.push(frame.params));
  const complete = waitForComplete(client);
  assert.deepEqual(await client.request("prompt.submit", {
    session_id: session.session_id,
    text: "reply PONG",
  }), { accepted: true });
  const payload = await complete;

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-key");
  assert.equal(requests[0].body.model, "openrouter/auto");
  assert.equal(requests[0].body.messages[0].content, "You are Oracle.");
  assert.equal(events.filter((event) => event.type === "message.delta").map((event) => event.payload.text).join(""), "PONG");
  assert.equal(payload.text, "PONG");
  assert.deepEqual(payload.usage, {
    context_used: 12,
    context_max: 128000,
    context_percent: 0,
    input: 12,
    output: 2,
  });
  await client.stop();
});

test("standalone client executes bounded Oracle tools before the final answer", async () => {
  const requests = [];
  const toolCalls = [];
  const responses = [
    sse([{
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "oracle_cli", arguments: '{"argv":["chain"]}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }]),
    sse([{ choices: [{ delta: { content: "chain read complete" }, finish_reason: "stop" }] }]),
  ];
  const client = createStandaloneClient({
    config: CONFIG,
    persona: "You are Oracle.",
    toolRunner: async (argv) => {
      toolCalls.push(argv);
      return { ok: true, stdout: "hyperliquid\n" };
    },
    fetchFn: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return responses.shift();
    },
  });

  await client.start();
  const session = await client.request("session.create", {});
  const complete = waitForComplete(client);
  await client.request("prompt.submit", { session_id: session.session_id, text: "what chain?" });
  assert.equal((await complete).text, "chain read complete");

  assert.deepEqual(toolCalls, [["chain"]]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.match(requests[1].messages.at(-1).content, /hyperliquid/);
  await client.stop();
});

function providerSse(frames) {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function syntheticJwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.`;
}

test("Claude OAuth streams through Anthropic Messages wire format", async () => {
  const requests = [];
  const client = createStandaloneClient({
    config: {
      ...CONFIG,
      provider: "anthropic-oauth",
      model: "claude-opus-4-8",
      baseUrl: "https://api.anthropic.com/v1",
      authType: "oauth",
      protocol: "anthropic-messages",
      apiKey: undefined,
    },
    persona: "You are Oracle.",
    credentialProvider: async () => ({ accessToken: "claude-oauth-access" }),
    fetchFn: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return providerSse([
        { type: "message_start", message: { usage: { input_tokens: 8 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CLAUDE" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    },
  });
  await client.start();
  const session = await client.request("session.create", {});
  const complete = waitForComplete(client);
  await client.request("prompt.submit", { session_id: session.session_id, text: "identify" });
  assert.equal((await complete).text, "CLAUDE");
  assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(requests[0].options.headers.Authorization, "Bearer claude-oauth-access");
  assert.match(requests[0].options.headers["anthropic-beta"], /oauth-2025-04-20/);
  assert.equal(requests[0].body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(requests[0].body.model, "claude-opus-4-8");
  await client.stop();
});

test("Codex OAuth streams Responses and sends the ChatGPT account header", async () => {
  const requests = [];
  const accessToken = syntheticJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "account-test" },
  });
  const client = createStandaloneClient({
    config: {
      ...CONFIG,
      provider: "openai-codex",
      model: "gpt-5.4",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authType: "oauth",
      protocol: "responses",
      apiKey: undefined,
    },
    persona: "You are Oracle.",
    credentialProvider: async () => ({ accessToken }),
    fetchFn: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return providerSse([
        { type: "response.output_text.delta", delta: "CODEX" },
        { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 1 } } },
      ]);
    },
  });
  await client.start();
  const session = await client.request("session.create", {});
  const complete = waitForComplete(client);
  await client.request("prompt.submit", { session_id: session.session_id, text: "identify" });
  assert.equal((await complete).text, "CODEX");
  assert.equal(requests[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(requests[0].options.headers["ChatGPT-Account-ID"], "account-test");
  assert.equal(requests[0].options.headers.originator, "codex_cli_rs");
  assert.equal(requests[0].body.instructions, "You are Oracle.");
  assert.equal(requests[0].body.input[0].role, "user");
  assert.equal(requests[0].body.tools[0].name, "oracle_cli");
  await client.stop();
});

test("Grok OAuth uses Responses and executes bounded Oracle tools", async () => {
  const requests = [];
  const toolCalls = [];
  const responses = [
    providerSse([
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_test",
          call_id: "call_test",
          name: "oracle_cli",
          arguments: '{"argv":["chain"]}',
        },
      },
      { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 1 } } },
    ]),
    providerSse([
      { type: "response.output_text.delta", delta: "GROK" },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
    ]),
  ];
  const client = createStandaloneClient({
    config: {
      ...CONFIG,
      provider: "xai-oauth",
      model: "grok-4.5",
      baseUrl: "https://api.x.ai/v1",
      authType: "oauth",
      protocol: "responses",
      apiKey: undefined,
    },
    persona: "You are Oracle.",
    credentialProvider: async () => ({ accessToken: "grok-oauth-access" }),
    toolRunner: async (argv) => {
      toolCalls.push(argv);
      return { ok: true, stdout: "hyperliquid" };
    },
    fetchFn: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return responses.shift();
    },
  });
  await client.start();
  const session = await client.request("session.create", {});
  const complete = waitForComplete(client);
  await client.request("prompt.submit", { session_id: session.session_id, text: "use chain tool" });
  assert.equal((await complete).text, "GROK");
  assert.deepEqual(toolCalls, [["chain"]]);
  assert.equal(requests[0].url, "https://api.x.ai/v1/responses");
  assert.equal(requests[0].options.headers["x-grok-conv-id"], session.session_id);
  assert.equal(requests[1].body.input.at(-1).type, "function_call_output");
  assert.equal(requests[1].body.input.at(-1).call_id, "call_test");
  await client.stop();
});

test("standalone client interruption aborts the active request", async () => {
  let aborted = false;
  const client = createStandaloneClient({
    config: CONFIG,
    persona: "You are Oracle.",
    fetchFn: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }),
  });

  await client.start();
  const session = await client.request("session.create", {});
  await client.request("prompt.submit", { session_id: session.session_id, text: "wait" });
  assert.deepEqual(await client.request("session.interrupt", { session_id: session.session_id }), { interrupted: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true);
  await client.stop();
});

test("Oracle tool runner blocks signing and server commands", async () => {
  const spawnCalls = [];
  const spawnFn = (...args) => {
    spawnCalls.push(args);
    return { status: 0, stdout: "ok", stderr: "" };
  };

  assert.deepEqual(await runOracleCommand(["sign", "init"], { spawnFn }), {
    ok: false,
    error: "command not allowed: sign",
  });
  assert.deepEqual(await runOracleCommand(["data", "serve"], { spawnFn }), {
    ok: false,
    error: "command not allowed: data serve",
  });
  assert.deepEqual(await runOracleCommand(["chain", "use", "base"], { spawnFn }), {
    ok: false,
    error: "command not allowed: chain use",
  });
  assert.deepEqual(await runOracleCommand(["chain", "clear"], { spawnFn }), {
    ok: false,
    error: "command not allowed: chain clear",
  });
  assert.equal(spawnCalls.length, 0);
});

test("OAuth clients reject non-provider inference endpoints", () => {
  assert.throws(() => createStandaloneClient({
    config: {
      ...CONFIG,
      provider: "anthropic-oauth",
      baseUrl: "https://attacker.example/v1",
      authType: "oauth",
      protocol: "anthropic-messages",
      apiKey: undefined,
    },
    persona: "You are Oracle.",
  }), /OAuth endpoint/);
});
