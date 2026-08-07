import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORACLE = path.join(ROOT, "bin", "oracle.mjs");
const runOracle = (args, env = {}) => spawnSync(process.execPath, [ORACLE, ...args], {
  encoding: "utf8", env: { ...process.env, ...env }, cwd: ROOT,
});

test("scan chains matches legacy bin", () => {
  const a = spawnSync(process.execPath, [path.join(ROOT, "bin", "oracle-scan.mjs"), "chains"], { encoding: "utf8", cwd: ROOT });
  const b = runOracle(["scan", "chains"]);
  assert.equal(a.status, b.status);
  assert.equal(b.stdout, a.stdout);
  assert.equal(b.stderr, a.stderr);
});

test("route no verb matches legacy", () => {
  const legacy = spawnSync(process.execPath, [path.join(ROOT, "bin", "oracle-route.mjs")], { encoding: "utf8", cwd: ROOT });
  const wrapped = runOracle(["route"]);
  assert.equal(wrapped.status, legacy.status);
  assert.equal((wrapped.stdout||"")+(wrapped.stderr||""), (legacy.stdout||"")+(legacy.stderr||""));
});

test("data health down exits 4", () => {
  const r = runOracle(["data", "health"], { ORACLE_DATA_URL: "http://127.0.0.1:1" });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /data server not running/);
});

test("data health up returns 0 (in-process, no spawn deadlock)", async () => {
  // NOTE: do not start an HTTP server here and then spawnSync the CLI.
  // spawnSync blocks this process's event loop, so the server can never
  // answer the child and the test deadlocks. Drive the command module
  // directly with a stubbed fetch instead.
  const mod = await import("../src/cli/commands/data.mjs");
  const origFetch = globalThis.fetch;
  const origWrite = process.stdout.write;
  let out = "";
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ ok: true }) });
  process.stdout.write = (c) => { out += c; return true; };
  try {
    const code = await mod.default.run({ argv: ["health"], root: ROOT, paths: {}, dispatchOperator: () => 0 });
    assert.equal(code, 0);
    assert.match(out, /"ok":\s*true/);
  } finally {
    globalThis.fetch = origFetch;
    process.stdout.write = origWrite;
  }
});
