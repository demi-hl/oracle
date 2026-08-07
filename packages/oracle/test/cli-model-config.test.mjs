import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  modelConfigPath,
  readModelConfig,
  writeModelConfig,
} from "../src/cli/model-config.mjs";
import { standaloneConfigFromEnv } from "../src/tui/backend.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-model-config-"));
}

test("standalone model config persists without API key material", () => {
  const home = tempHome();
  process.env.ORACLE_FAKE_HOME = home;
  try {
    const written = writeModelConfig({
      backend: "standalone",
      provider: "openrouter",
      model: "openrouter/auto",
      apiKeyEnv: "OPENROUTER_API_KEY",
    });
    assert.equal(written.backend, "standalone");
    assert.deepEqual(readModelConfig(), written);
    const raw = fs.readFileSync(modelConfigPath(), "utf8");
    assert.doesNotMatch(raw, /test-secret|apiKey"/);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(modelConfigPath()).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(modelConfigPath())).mode & 0o777, 0o700);
    }
  } finally {
    delete process.env.ORACLE_FAKE_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("stored model config resolves its API key from the named environment variable", () => {
  const config = standaloneConfigFromEnv(
    { OPENROUTER_API_KEY: "test-secret" },
    {
      backend: "standalone",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
  );
  assert.equal(config.provider, "openrouter");
  assert.equal(config.model, "anthropic/claude-sonnet-4.6");
  assert.equal(config.apiKey, "test-secret");
});

test("oracle model preserves arbitrary OAuth-compatible model selections", () => {
  const home = tempHome();
  try {
    const result = spawnSync(process.execPath, [
      ORACLE,
      "model",
      "--backend", "standalone",
      "--provider", "anthropic-oauth",
      "--model", "claude-opus-4-8",
      "--reasoning-effort", "high",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ORACLE_FAKE_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(home, ".config", "oracle", "model.json"), "utf8"));
    assert.equal(saved.provider, "anthropic-oauth");
    assert.equal(saved.model, "claude-opus-4-8");
    assert.equal(saved.reasoningEffort, "high");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("switching providers clears stale endpoint and key-environment fields", () => {
  const home = tempHome();
  try {
    const env = { ...process.env, ORACLE_FAKE_HOME: home };
    const custom = spawnSync(process.execPath, [
      ORACLE, "model", "--backend", "standalone", "--provider", "custom",
      "--model", "custom-model", "--base-url", "https://custom.example/v1",
      "--api-key-env", "CUSTOM_KEY",
    ], { cwd: ROOT, encoding: "utf8", env });
    assert.equal(custom.status, 0, custom.stderr);

    const switched = spawnSync(process.execPath, [
      ORACLE, "model", "--provider", "openrouter", "--model", "openrouter/auto",
    ], { cwd: ROOT, encoding: "utf8", env });
    assert.equal(switched.status, 0, switched.stderr);
    const saved = JSON.parse(fs.readFileSync(path.join(home, ".config", "oracle", "model.json"), "utf8"));
    assert.equal(saved.provider, "openrouter");
    assert.equal(saved.baseUrl, undefined);
    assert.equal(saved.apiKeyEnv, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("named providers reject custom base URLs", () => {
  const home = tempHome();
  try {
    const result = spawnSync(process.execPath, [
      ORACLE, "model", "--backend", "standalone", "--provider", "openrouter",
      "--model", "openrouter/auto", "--base-url", "https://attacker.example/v1",
    ], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ORACLE_FAKE_HOME: home } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /baseUrl is only supported for the custom provider/);
    assert.equal(fs.existsSync(path.join(home, ".config", "oracle", "model.json")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("oracle model configures standalone mode without installing Hermes", () => {
  const home = tempHome();
  try {
    const result = spawnSync(process.execPath, [
      ORACLE,
      "model",
      "--backend", "standalone",
      "--provider", "openrouter",
      "--model", "openrouter/auto",
      "--api-key-env", "OPENROUTER_API_KEY",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ORACLE_FAKE_HOME: home,
        PATH: path.join(home, "empty-bin"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /standalone/);
    const saved = JSON.parse(fs.readFileSync(path.join(home, ".config", "oracle", "model.json"), "utf8"));
    assert.equal(saved.provider, "openrouter");
    assert.equal(saved.model, "openrouter/auto");
    assert.equal(fs.existsSync(path.join(home, ".config", "oracle", "runtime", "venv")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("public desktop mode rejects saved remote compute backends", () => {
  const home = tempHome();
  const prevHome = process.env.ORACLE_FAKE_HOME;
  const prevDesktop = process.env.ORACLE_PUBLIC_DESKTOP;
  process.env.ORACLE_FAKE_HOME = home;
  process.env.ORACLE_PUBLIC_DESKTOP = "1";
  try {
    assert.throws(
      () => writeModelConfig({ backend: "arch", computeHost: "gpu-box" }),
      /remote compute backends are disabled/,
    );
  } finally {
    if (prevHome === undefined) delete process.env.ORACLE_FAKE_HOME;
    else process.env.ORACLE_FAKE_HOME = prevHome;
    if (prevDesktop === undefined) delete process.env.ORACLE_PUBLIC_DESKTOP;
    else process.env.ORACLE_PUBLIC_DESKTOP = prevDesktop;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
