import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHATGPT_CANNOT_SIGN } from "../src/cli/mcp-targets/chatgpt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");
const runOracle = (args, env = {}) => spawnSync(process.execPath, [ORACLE, ...args], {
  encoding: "utf8", env: { ...process.env, ...env }, cwd: ROOT,
});

test("mcp print claude-code", () => {
  const r = runOracle(["mcp", "print", "--target", "claude-code"], { ORACLE_OPERATOR_BIN_DIR: "/nonexistent" });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.ok(j.mcpServers["oracle-data"].args[0].endsWith(`${path.sep}bin${path.sep}oracle-data-mcp.mjs`));
  assert.equal(j.mcpServers["oracle-control"], undefined);
});

test("mcp print --with-control no operator exits 3", () => {
  const r = runOracle(["mcp", "print", "--target", "claude-code", "--with-control"], { ORACLE_OPERATOR_BIN_DIR: "/nonexistent" });
  assert.equal(r.status, 3);
});

test("mcp print --with-control fake operator", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-mcp-op-"));
  const control = path.join(dir, "oracle-control-mcp.mjs");
  fs.writeFileSync(control, "#!/usr/bin/env node\n");
  try {
    const r = runOracle(["mcp", "print", "--target", "claude-code", "--with-control"], { ORACLE_OPERATOR_BIN_DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).mcpServers["oracle-control"].args[0], control);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("codex install idempotent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-home-"));
  try {
    const r1 = runOracle(["mcp", "install", "codex"], { ORACLE_FAKE_HOME: home });
    assert.equal(r1.status, 0, r1.stderr);
    const cfg = path.join(home, ".codex", "config.toml");
    const first = fs.readFileSync(cfg, "utf8");
    assert.match(first, /oracle-mcp-install begin/);
    const bakBefore = fs.readdirSync(path.join(home, ".codex")).filter((f) => f.includes(".bak-oracle-"));
    const r2 = runOracle(["mcp", "install", "codex"], { ORACLE_FAKE_HOME: home });
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /present/);
    assert.equal(fs.readFileSync(cfg, "utf8"), first);
    const bakAfter = fs.readdirSync(path.join(home, ".codex")).filter((f) => f.includes(".bak-oracle-"));
    assert.equal(bakAfter.length, bakBefore.length);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("chatgpt install cannot-sign + openapi", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-home-cg-"));
  try {
    const r = runOracle(["mcp", "install", "chatgpt"], { ORACLE_FAKE_HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(CHATGPT_CANNOT_SIGN));
    const specPath = path.join(home, ".config", "oracle", "connectors", "chatgpt-openapi.json");
    const doc = JSON.parse(fs.readFileSync(specPath, "utf8"));
    assert.equal(doc.openapi, "3.1.0");
    assert.ok(doc.paths["/public/health"]);
    assert.doesNotMatch(JSON.stringify(doc).toLowerCase(), /private_key|oracle-signer/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
