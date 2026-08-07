import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-standalone-skill-security-"));
const configDir = path.join(root, "config");
const outsideDir = path.join(root, "outside");
fs.mkdirSync(path.join(configDir, "skills"), { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });
process.env.ORACLE_CONFIG_DIR = configDir;

const { createStandaloneClient } = await import("../src/tui/standalone-client.mjs");

const CONFIG = Object.freeze({
  kind: "standalone",
  provider: "openrouter",
  model: "openrouter/auto",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: ["test", "key"].join("-"),
  contextLength: 128000,
  reasoningEffort: "high",
});

function sse(chunks) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
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

test("standalone skill_load traversal cannot exfiltrate outside files into the next model request", async () => {
  const marker = "OUTSIDE_STANDALONE_SECRET_MARKER";
  fs.writeFileSync(path.join(outsideDir, "readme.md"), marker);

  const requests = [];
  const responses = [
    sse([{
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "skill_load", arguments: '{"name":"../../outside/readme"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }]),
    sse([{ choices: [{ delta: { content: "blocked" }, finish_reason: "stop" }] }]),
  ];

  const client = createStandaloneClient({
    config: CONFIG,
    persona: "You are Oracle.",
    fetchFn: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return responses.shift();
    },
  });

  await client.start();
  const session = await client.request("session.create", {});
  const complete = waitForComplete(client);
  await client.request("prompt.submit", { session_id: session.session_id, text: "load skill" });
  assert.equal((await complete).text, "blocked");
  await client.stop();

  assert.equal(requests.length, 2);
  const secondRequest = JSON.stringify(requests[1]);
  assert.equal(secondRequest.includes(marker), false);
  assert.match(secondRequest, /skill not found/);
});
