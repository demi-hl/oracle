import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-standalone-"));
}

function runOracleAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ORACLE, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("one-shot chat works on a fresh machine without Hermes", async () => {
  const home = tempHome();
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "PO" }, finish_reason: null }] })}`,
        "",
        `data: ${JSON.stringify({ choices: [{ delta: { content: "NG" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 2 } })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const result = await runOracleAsync(["-q", "reply PONG"], {
      ORACLE_FAKE_HOME: home,
      ORACLE_CHAT_BACKEND: "standalone",
      ORACLE_BASE_URL: `http://127.0.0.1:${port}/v1`,
      ORACLE_MODEL: "test-model",
      ORACLE_API_KEY: "test-key",
      PATH: path.join(home, "empty-bin"),
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "PONG");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[0].headers.authorization, "Bearer test-key");
    assert.equal(requests[0].body.model, "test-model");
    assert.match(requests[0].body.messages[0].content, /You are \*\*Oracle\*\*/);
    assert.equal(requests[0].body.tools[0].function.name, "oracle_cli");
    assert.equal(fs.existsSync(path.join(home, ".hermes")), false);
    assert.equal(fs.existsSync(path.join(home, ".config", "oracle", "runtime", "venv")), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("fresh unconfigured chat says Hermes is optional and never bootstraps it", () => {
  const home = tempHome();
  try {
    const result = spawnSync(process.execPath, [ORACLE, "chat"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ORACLE_FAKE_HOME: home,
        PATH: path.join(home, "empty-bin"),
        ORACLE_CHAT_BACKEND: "auto",
        OPENROUTER_API_KEY: "",
        OPENAI_API_KEY: "",
        XAI_API_KEY: "",
        DEEPSEEK_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
        ORACLE_API_KEY: "",
        ORACLE_BASE_URL: "",
        ORACLE_MODEL: "",
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no Hermes or external agent required/i);
    assert.match(result.stderr, /OPENROUTER_API_KEY/);
    assert.doesNotMatch(result.stderr, /run: oracle bootstrap/);
    assert.equal(fs.existsSync(path.join(home, ".config", "oracle", "runtime", "venv")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
