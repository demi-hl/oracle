import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIGN_HINT } from "../src/cli/operator-dispatch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");
const runOracle = (args, env = {}) => spawnSync(process.execPath, [ORACLE, ...args], {
  encoding: "utf8", env: { ...process.env, ...env }, cwd: ROOT,
});

function makeFakeBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-sign-bins-"));
  for (const [name, body] of [
    ["oracle-vault", "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n"],
    ["oracle-signer", "#!/usr/bin/env node\nprocess.stderr.write('oracle-signer: credential unavailable\\n'); process.exit(2);\n"],
    ["oracle-agentic-doctor", "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true,argv:process.argv.slice(2)}));\n"],
  ]) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body, { mode: 0o755 });
    fs.chmodSync(p, 0o755);
  }
  return dir;
}

test("vault argv passthrough", () => {
  const dir = makeFakeBinDir();
  try {
    const r = runOracle(["vault", "inspect", "/tmp/x", "--stdout"], { ORACLE_OPERATOR_BIN_DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ["inspect", "/tmp/x", "--stdout"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("sign nouns missing operator exit 3", () => {
  for (const noun of ["vault", "credential", "signer", "runner", "sign"]) {
    const args = noun === "sign" ? ["sign", "init"] : [noun, "x"];
    const r = runOracle(args, { ORACLE_OPERATOR_BIN_DIR: "/nonexistent" });
    assert.equal(r.status, 3, noun);
    assert.match(r.stderr, /signing is unavailable in the public package/, noun);
    assert.match(r.stderr, /has no public npm install/, noun);
    assert.doesNotMatch(r.stderr, /npm i(?:nstall)?\s+(?:-g\s+)?@oracle-agent\/operator/, noun);
  }
});

test("signer exit 2 appends hint", () => {
  const dir = makeFakeBinDir();
  try {
    const r = runOracle(["signer"], { ORACLE_OPERATOR_BIN_DIR: dir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /credential unavailable/);
    assert.match(r.stderr, new RegExp(SIGN_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("sign doctor dispatches", () => {
  const dir = makeFakeBinDir();
  try {
    const r = runOracle(["sign", "doctor", "--json"], { ORACLE_OPERATOR_BIN_DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).argv, ["--json"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
