import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");
const INIT = path.join(ROOT, "bin", "oracle-init.mjs");
const runOracle = (args, env = {}) => spawnSync(process.execPath, [ORACLE, ...args], {
  encoding: "utf8", env: { ...process.env, ...env }, cwd: ROOT,
});

test("init dry-run matches legacy", () => {
  const legacy = spawnSync(process.execPath, [INIT], { encoding: "utf8", cwd: ROOT, env: process.env });
  const wrapped = runOracle(["init"]);
  assert.equal(wrapped.status, legacy.status);
  assert.equal(wrapped.stdout, legacy.stdout);
});

test("doctor --json no operator", () => {
  const r = runOracle(["doctor", "--json"], {
    ORACLE_OPERATOR_BIN_DIR: "/nonexistent",
    ORACLE_DATA_URL: "http://127.0.0.1:1",
  });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.operator.installed, false);
  assert.equal(j.ok, true);
});

test("doctor labels installed-but-unready signing as a warning", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-doctor-op-"));
  fs.writeFileSync(
    path.join(dir, "oracle-agentic-doctor.mjs"),
    'process.stdout.write(JSON.stringify({ signingReady: false, broadcastReady: false, executionReady: false }));\n',
  );
  try {
    const r = runOracle(["doctor", "--json"], {
      ORACLE_OPERATOR_BIN_DIR: dir,
      ORACLE_DATA_URL: "http://127.0.0.1:1",
    });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.operator.installed, true);
    assert.equal(j.operator.signingReady, false);
    assert.equal(j.checks.find((c) => c.id === "signing").status, "warn");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor text optional signing", () => {
  const r = runOracle(["doctor"], {
    ORACLE_OPERATOR_BIN_DIR: "/nonexistent",
    ORACLE_DATA_URL: "http://127.0.0.1:1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not installed \(optional\)/);
});
