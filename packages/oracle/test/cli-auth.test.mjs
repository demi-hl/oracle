import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");

function run(home, args, input = "") {
  return spawnSync(process.execPath, [ORACLE, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      ORACLE_FAKE_HOME: home,
      ORACLE_AUTH_FILE_STORE: "1",
    },
  });
}

test("oracle auth stores API keys without exposing them in output or model config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-auth-cli-"));
  const secret = "synthetic-provider-key";
  try {
    const configured = run(home, ["auth", "api-key", "openrouter", "--stdin"], `${secret}\n`);
    assert.equal(configured.status, 0, configured.stderr);
    assert.doesNotMatch(configured.stdout + configured.stderr, new RegExp(secret));

    const status = run(home, ["auth", "status", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout + status.stderr, new RegExp(secret));
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.apiKeys.openrouter.configured, true);

    const modelFile = path.join(home, ".config", "oracle", "model.json");
    const model = JSON.parse(fs.readFileSync(modelFile, "utf8"));
    assert.equal(model.provider, "openrouter");
    assert.doesNotMatch(JSON.stringify(model), new RegExp(secret));

    const removed = run(home, ["auth", "logout", "openrouter"]);
    assert.equal(removed.status, 0, removed.stderr);
    const finalStatus = JSON.parse(run(home, ["auth", "status", "--json"]).stdout);
    assert.equal(finalStatus.apiKeys.openrouter, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("OpenAI API-key auth uses the direct API model preset", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-auth-cli-"));
  try {
    const configured = run(home, ["auth", "api-key", "openai", "--stdin"], "synthetic-openai-key\n");
    assert.equal(configured.status, 0, configured.stderr);
    const model = JSON.parse(fs.readFileSync(path.join(home, ".config", "oracle", "model.json"), "utf8"));
    assert.equal(model.provider, "openai");
    assert.equal(model.model, "gpt-4.1-mini");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("oracle auth validates custom provider config before storing its key", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-auth-cli-"));
  const secret = "synthetic-custom-key";
  try {
    const rejected = run(home, ["auth", "api-key", "custom", "--stdin", "--model", "custom-model"], `${secret}\n`);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /base-url/);
    const status = JSON.parse(run(home, ["auth", "status", "--json"]).stdout);
    assert.equal(status.apiKeys.custom, undefined);

    const configured = run(home, [
      "auth", "api-key", "custom", "--stdin", "--model", "custom-model",
      "--base-url", "https://custom.example/v1",
    ], `${secret}\n`);
    assert.equal(configured.status, 0, configured.stderr);
    const model = JSON.parse(fs.readFileSync(path.join(home, ".config", "oracle", "model.json"), "utf8"));
    assert.equal(model.provider, "custom");
    assert.equal(model.baseUrl, "https://custom.example/v1");
    assert.doesNotMatch(JSON.stringify(model), new RegExp(secret));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("oracle auth refuses implicit secret reads in non-interactive mode", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-auth-cli-"));
  try {
    const result = run(home, ["auth", "api-key", "openai"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--stdin/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
