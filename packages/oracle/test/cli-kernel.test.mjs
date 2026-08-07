import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRootChatFlag,
  renderHelp,
  shouldLaunchChat,
} from "../src/cli/kernel.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");
const runOracle = (args, env = {}) => spawnSync(process.execPath, [ORACLE, ...args], {
  encoding: "utf8", env: { ...process.env, ...env }, cwd: ROOT,
});

test("oracle --help prints grouped help", () => {
  const r = runOracle(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self-custody multichain agent control plane/);
  assert.match(r.stdout, /READ \/ RESEARCH/);
  assert.match(r.stdout, /SIGNING/);
});

test("oracle version prints package version", () => {
  const r = runOracle(["version"], { ORACLE_OPERATOR_BIN_DIR: "/nonexistent" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^oracle \d+\.\d+\.\d+/);
  assert.doesNotMatch(r.stdout, /operator /);
});

test("sign noun without operator exits 3", () => {
  const r = runOracle(["vault", "inspect", "x"], { ORACLE_OPERATOR_BIN_DIR: "/nonexistent" });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /signing is unavailable in the public package/);
  assert.match(r.stderr, /has no public npm install/);
  assert.doesNotMatch(r.stderr, /npm i(?:nstall)?\s+(?:-g\s+)?@oracle-agent\/operator/);
});

test("unknown noun exits 1", () => {
  const r = runOracle(["not-a-real-command"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command/);
});

test("renderHelp tolerates empty map", () => {
  const text = renderHelp("0.4.2", new Map());
  assert.match(text, /v0\.4\.2/);
  assert.match(text, /READ \/ RESEARCH/);
});

test("oracle with no args prints help", () => {
  const r = runOracle([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /self-custody/);
});

test("bare oracle launches chat only in a tty", () => {
  const tty = { stdin: { isTTY: true }, stdout: { isTTY: true } };
  const pipe = { stdin: { isTTY: false }, stdout: { isTTY: false } };
  assert.equal(shouldLaunchChat([], tty), true);
  assert.equal(shouldLaunchChat([], pipe), false);
  assert.equal(shouldLaunchChat(["--help"], tty), false);
});

test("root chat flags route into the oracle chat surface", () => {
  for (const flag of ["-m", "--model", "-q", "--query", "-c", "--continue"]) {
    assert.equal(isRootChatFlag(flag), true, flag);
  }
  assert.equal(isRootChatFlag("--help"), false);
  assert.equal(isRootChatFlag("chain"), false);
});

test("oracle model is advertised", () => {
  const r = runOracle(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /oracle model/);
  assert.match(r.stdout, /open the native Oracle chat/);
});
