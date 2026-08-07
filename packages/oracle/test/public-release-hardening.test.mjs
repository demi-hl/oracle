import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { Interface } from "ethers";

import {
  createAutoSlippageGuard,
  assertAutoSlippageGuard,
  bindAutoSlippageGuardToCall,
} from "../src/auto-slippage.mjs";
import { isApprovalCall } from "../src/approval-guard.mjs";
import { httpJson } from "../src/data/http.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const LOCAL_IMPORT_RE = /(?:from\s*|import\s*)["'](\.\.?\/[^"']+)["']/g;
const PRIVATE_MODULES = new Set(["hl-exec", "key-vault"]);
const VENUE = "0x2626664c2603336E57B271c5C0b26F421741e481";

function resolveLocalImport(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  return [base, `${base}.mjs`, `${base}.js`, path.join(base, "index.mjs")]
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function walkImports(entry, seen = new Set(), chain = []) {
  const abs = path.resolve(entry);
  if (seen.has(abs)) return [];
  seen.add(abs);
  const rel = path.relative(ROOT, abs);
  const nextChain = [...chain, rel];
  const base = path.basename(abs).replace(/\.mjs$/, "");
  if (PRIVATE_MODULES.has(base)) return [nextChain];
  const body = fs.readFileSync(abs, "utf8");
  const hits = [];
  LOCAL_IMPORT_RE.lastIndex = 0;
  let match;
  while ((match = LOCAL_IMPORT_RE.exec(body))) {
    const target = resolveLocalImport(abs, match[1]);
    if (target) hits.push(...walkImports(target, seen, nextChain));
  }
  return hits;
}

function packedFiles() {
  const parsed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  }));
  const pack = Array.isArray(parsed)
    ? parsed[0]
    : parsed.files
      ? parsed
      : Object.values(parsed).find((value) => value && Array.isArray(value.files));
  return new Set((pack?.files || []).map((entry) => entry.path));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function withNoAttestationSecrets(fn) {
  const saved = {
    oracle: process.env.ORACLE_ROUTE_ATTESTATION_SECRET,
    mad: process.env.MAD_ROUTE_ATTESTATION_SECRET,
    isolate: process.env.ORACLE_TEST_ISOLATE_SECRETS,
    execEnv: process.env.ORACLE_EXEC_ENV_FILE,
    madEnv: process.env.MAD_EXEC_ENV_FILE,
  };
  delete process.env.ORACLE_ROUTE_ATTESTATION_SECRET;
  delete process.env.MAD_ROUTE_ATTESTATION_SECRET;
  delete process.env.ORACLE_EXEC_ENV_FILE;
  delete process.env.MAD_EXEC_ENV_FILE;
  process.env.ORACLE_TEST_ISOLATE_SECRETS = "1";
  try {
    return fn();
  } finally {
    if (saved.oracle === undefined) delete process.env.ORACLE_ROUTE_ATTESTATION_SECRET;
    else process.env.ORACLE_ROUTE_ATTESTATION_SECRET = saved.oracle;
    if (saved.mad === undefined) delete process.env.MAD_ROUTE_ATTESTATION_SECRET;
    else process.env.MAD_ROUTE_ATTESTATION_SECRET = saved.mad;
    if (saved.isolate === undefined) delete process.env.ORACLE_TEST_ISOLATE_SECRETS;
    else process.env.ORACLE_TEST_ISOLATE_SECRETS = saved.isolate;
    if (saved.execEnv === undefined) delete process.env.ORACLE_EXEC_ENV_FILE;
    else process.env.ORACLE_EXEC_ENV_FILE = saved.execEnv;
    if (saved.madEnv === undefined) delete process.env.MAD_EXEC_ENV_FILE;
    else process.env.MAD_EXEC_ENV_FILE = saved.madEnv;
  }
}

async function startDeskServer(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["bin/desk-server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ORACLE_DATA_HOST: "127.0.0.1",
      ORACLE_DATA_PORT: String(port),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let i = 0; i < 50; i++) {
    if (child.exitCode != null) throw new Error(`desk-server exited early: ${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
      if (response.ok) return { child, port };
    } catch {}
    await sleep(50);
  }
  child.kill("SIGKILL");
  throw new Error(`desk-server did not become ready: ${stderr}`);
}

test("public package entrypoints cannot reach signing or key material", () => {
  const entries = Object.values(pkg.exports || {})
    .map((target) => path.join(ROOT, String(target).replace(/^\.\//, "")));
  const violations = entries.flatMap((entry) => walkImports(entry, new Set()));
  assert.deepEqual(
    violations,
    [],
    `public import graph reached private modules:\n${violations.map((chain) => `  ${chain.join(" -> ")}`).join("\n")}`,
  );
});

test("public root and data catalog expose no live signing lane", async () => {
  const root = await import(pkg.name);
  const data = await import(`${pkg.name}/data`);
  for (const name of ["encryptKey", "decryptKey", "readKeyMaterial", "hlSignAndSubmit", "hlTrade", "executionCall"]) {
    assert.equal(root[name], undefined, `public root must not export ${name}`);
    assert.equal(data[name], undefined, `public data facade must not export ${name}`);
  }
  assert.equal(pkg.exports["./key-vault"], undefined, "public package must not export the key vault");
  assert.equal(
    data.dataCatalog().some((provider) => provider.id === "hl-exec" || provider.execution === "live"),
    false,
    "public data catalog must not advertise a live execution provider",
  );
});

test("packed npm artifact includes setup docs and explicit action semantics without signer code", () => {
  const files = packedFiles();
  assert.equal(files.has("SETUP.md"), true, "README-linked SETUP.md must ship");
  assert.equal(files.has("src/action-semantics.mjs"), true, "action semantics module must ship");
  assert.equal(
    files.has("skills/oracle-action-semantics/SKILL.md"),
    true,
    "Hermes action semantics skill must ship",
  );
  assert.equal(files.has("src/key-vault.mjs"), false, "key vault must not ship");
  assert.equal(files.has("src/data/providers/hl-exec.mjs"), false, "live signer must not ship");
});

test("console labels local state as a preview and makes no enforcement claim", () => {
  const html = fs.readFileSync(path.join(ROOT, "public/oracle-console/index.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "public/oracle-console/app.js"), "utf8");
  assert.match(html, /Preview agent permissions/);
  assert.match(html, /Connect/);
  assert.match(html, /Review/);
  assert.match(html, /Preview/);
  assert.match(html, /Clear preview/);
  assert.doesNotMatch(html, /\bEnforced\b|\bRevoke\b/);
  assert.equal(js.includes("personal_sign"), false, "preview must not request a discarded signature");
  assert.equal(js.includes("Agent connected and enforced"), false);
  assert.equal(js.includes("Revoked. The agent can no longer act under this grant."), false);
  assert.match(js, /preview/i);
});

test("unknown and unsupported modern swap selectors fail closed", () => {
  const guard = createAutoSlippageGuard({
    chainId: 8453,
    venue: VENUE,
    quoteAmountOut: "1000000",
    liquidityUsd: 250_000,
    quotedAtMs: 1_000_000,
  });
  for (const data of [
    `0xdeadbeef${"0".repeat(64)}`,
    `0x04e45aaf${"0".repeat(64 * 7)}`,
    `0x3593564c${"0".repeat(64 * 4)}`,
  ]) {
    assert.throws(
      () => assertAutoSlippageGuard(guard, { nowMs: 1_001_000, chainId: 8453, venue: VENUE, tx: { data } }),
      /unsupported swap selector|cannot verify (?:calldata|the) output floor|not bound to this call/,
    );
  }
});

test("Uniswap exactInput binds the dynamic tuple amountOutMinimum", () => {
  const guard = createAutoSlippageGuard({
    chainId: 8453,
    venue: VENUE,
    quoteAmountOut: "1000000",
    liquidityUsd: 250_000,
    quotedAtMs: 1_000_000,
  });
  const iface = new Interface([
    "function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params)",
  ]);
  const params = {
    path: "0x1111111111111111111111111111111111111111000bb82222222222222222222222222222222222222222",
    recipient: "0x3333333333333333333333333333333333333333",
    deadline: 2_000_000,
    amountIn: 500000n,
    amountOutMinimum: BigInt(guard.minAmountOut),
  };
  const good = iface.encodeFunctionData("exactInput", [params]);
  assert.doesNotThrow(() =>
    assertAutoSlippageGuard(guard, { nowMs: 1_001_000, chainId: 8453, venue: VENUE, tx: { data: good } }),
  );
  const bad = iface.encodeFunctionData("exactInput", [{ ...params, amountOutMinimum: 0n }]);
  assert.throws(
    () => assertAutoSlippageGuard(guard, { nowMs: 1_001_000, chainId: 8453, venue: VENUE, tx: { data: bad } }),
    /not bound to this call/,
  );
});

test("calldata hash binding preserves complex router support without decoding", () => {
  const guard = createAutoSlippageGuard({
    chainId: 8453,
    venue: VENUE,
    quoteAmountOut: "1000000",
    liquidityUsd: 250_000,
    quotedAtMs: 1_000_000,
  });
  const data = `0x3593564c${"1".repeat(64 * 4)}`;
  const bound = bindAutoSlippageGuardToCall(guard, { chainId: 8453, venue: VENUE, data });
  assert.doesNotThrow(() =>
    assertAutoSlippageGuard(bound, { nowMs: 1_001_000, chainId: 8453, venue: VENUE, tx: { data } }),
  );
  assert.throws(
    () => assertAutoSlippageGuard(bound, { nowMs: 1_001_000, chainId: 8453, venue: VENUE, tx: { data: `${data}00` } }),
    /not bound to this call/,
  );
});

test("execution cannot trust a caller-bound guard without an attestation secret", () => withNoAttestationSecrets(() => {
  const guard = createAutoSlippageGuard({
    chainId: 8453,
    venue: VENUE,
    quoteAmountOut: "1000000",
    liquidityUsd: 250_000,
    quotedAtMs: 1_000_000,
  });
  const data = `0x3593564c${"1".repeat(64 * 4)}`;
  const bound = bindAutoSlippageGuardToCall(guard, { chainId: 8453, venue: VENUE, data });
  assert.throws(
    () => assertAutoSlippageGuard(bound, {
      nowMs: 1_001_000,
      chainId: 8453,
      venue: VENUE,
      tx: { data },
      requireSigned: true,
      secret: "",
    }),
    /attestation secret required|ORACLE_ROUTE_ATTESTATION_SECRET required/,
  );
}));

test("every allowance-mutating selector enters the approval guard path", () => {
  for (const selector of [
    "0x095ea7b3",
    "0x39509351",
    "0x87517c45",
    "0xd505accf",
    "0x8fcbaf0c",
    "0x2b67b570",
    "0x2a2d80d1",
  ]) {
    assert.equal(isApprovalCall(`${selector}${"0".repeat(64 * 8)}`), true, `${selector} must be guarded`);
  }
});

test("provider-specific credential headers cannot share an in-flight response", async () => {
  let upstream = 0;
  const fetchImpl = async (url, init = {}) => {
    upstream++;
    const key = init.headers["0x-api-key"];
    await sleep(15);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ servedFor: key }),
    };
  };
  const url = `https://example.test/zerox-${Math.random()}`;
  const [a, b] = await Promise.all([
    httpJson(url, { fetchImpl, headers: { "0x-api-key": "key-alice" } }),
    httpJson(url, { fetchImpl, headers: { "0x-api-key": "key-bob" } }),
  ]);
  assert.equal(a.servedFor, "key-alice");
  assert.equal(b.servedFor, "key-bob");
  assert.equal(upstream, 2);
});

test("desk-server refuses a non-loopback bind", { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ["bin/desk-server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, ORACLE_DATA_HOST: "0.0.0.0", ORACLE_DATA_PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve({ code }))),
    sleep(1_000).then(() => ({ timeout: true })),
  ]);
  if (result.timeout) child.kill("SIGKILL");
  assert.equal(result.timeout, undefined, "server must refuse before listening");
  assert.notEqual(result.code, 0);
  assert.match(stderr, /loopback/i);
});

test("desk-server rejects oversized JSON before parsing it", { timeout: 10_000 }, async (t) => {
  const { child, port } = await startDeskServer();
  t.after(() => child.kill("SIGKILL"));
  const body = JSON.stringify({ provider: "missing", op: "missing", pad: "x".repeat(70_000) });
  const response = await fetch(`http://127.0.0.1:${port}/data/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 413);
});

test("broadcast fails closed when the durable daily ledger is corrupt", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "oracle-ledger-corrupt-"));
  const state = path.join(dir, "daily.json");
  fs.writeFileSync(state, "not-json", { mode: 0o600 });
  const saved = process.env.ORACLE_POLICY_STATE;
  process.env.ORACLE_POLICY_STATE = state;
  try {
    const { enforceTxPolicy } = await import(`../src/exec-policy.mjs?corrupt=${Date.now()}`);
    assert.throws(
      () => enforceTxPolicy({ chainId: 8453, to: VENUE, value: "1", data: "0x" }, "broadcast"),
      /ledger.*corrupt|ledger.*read|invalid.*ledger/i,
    );
  } finally {
    if (saved === undefined) delete process.env.ORACLE_POLICY_STATE;
    else process.env.ORACLE_POLICY_STATE = saved;
  }
});

test("broadcast fails closed when the durable daily ledger cannot be written", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "oracle-ledger-readonly-"));
  fs.chmodSync(dir, 0o500);
  const state = path.join(dir, "daily.json");
  const saved = process.env.ORACLE_POLICY_STATE;
  process.env.ORACLE_POLICY_STATE = state;
  try {
    const { enforceTxPolicy } = await import(`../src/exec-policy.mjs?readonly=${Date.now()}`);
    assert.throws(
      () => enforceTxPolicy({ chainId: 8453, to: VENUE, value: "1", data: "0x" }, "broadcast"),
      /ledger.*(?:writ|persist|lock|acquir)/i,
    );
  } finally {
    fs.chmodSync(dir, 0o700);
    if (saved === undefined) delete process.env.ORACLE_POLICY_STATE;
    else process.env.ORACLE_POLICY_STATE = saved;
  }
});

test("broadcast fails closed when another process holds the daily ledger lock", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "oracle-ledger-locked-"));
  const state = path.join(dir, "daily.json");
  const lock = `${state}.lock`;
  fs.mkdirSync(lock, { mode: 0o700 });
  // Fresh lock owned by this still-alive process must not be stolen.
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }),
    { mode: 0o600 },
  );
  const saved = process.env.ORACLE_POLICY_STATE;
  process.env.ORACLE_POLICY_STATE = state;
  try {
    const { enforceTxPolicy } = await import(`../src/exec-policy.mjs?locked=${Date.now()}`);
    assert.throws(
      () => enforceTxPolicy({ chainId: 8453, to: VENUE, value: "1", data: "0x" }, "broadcast"),
      /ledger.*lock|ledger.*busy/i,
    );
  } finally {
    if (saved === undefined) delete process.env.ORACLE_POLICY_STATE;
    else process.env.ORACLE_POLICY_STATE = saved;
  }
});

test("broadcast refuses stale daily ledger locks instead of racing to reclaim them", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "oracle-ledger-stale-"));
  const state = path.join(dir, "daily.json");
  const lock = `${state}.lock`;
  fs.mkdirSync(lock, { mode: 0o700 });
  // pid 2^30 is not a running process on any sane host; treat as dead owner.
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: 1_073_741_824, createdAtMs: Date.now() - 120_000 }),
    { mode: 0o600 },
  );
  const saved = process.env.ORACLE_POLICY_STATE;
  process.env.ORACLE_POLICY_STATE = state;
  try {
    const { enforceTxPolicy } = await import(`../src/exec-policy.mjs?stale=${Date.now()}`);
    assert.throws(
      () => enforceTxPolicy({ chainId: 8453, to: VENUE, value: "1", data: "0x" }, "broadcast"),
      /stale.*manual operator recovery|ledger.*lock/i,
    );
    assert.equal(fs.existsSync(lock), true, "a stale lock must never be deleted automatically");
  } finally {
    if (saved === undefined) delete process.env.ORACLE_POLICY_STATE;
    else process.env.ORACLE_POLICY_STATE = saved;
  }
});

test("prepared protocol routes reject unsigned caller-bound guards", async () => {
  const { assertPreparedProtocolRoute } = await import("../src/protocol-execution.mjs");
  const { createAutoSlippageGuard, bindAutoSlippageGuardToCall } = await import("../src/auto-slippage.mjs");
  withNoAttestationSecrets(() => {
    const data = `0x3593564c${"1".repeat(64 * 4)}`;
    const guard = createAutoSlippageGuard({
      chainId: 8453,
      venue: VENUE,
      quoteAmountOut: "1000000",
      liquidityUsd: 250_000,
      quotedAtMs: 1_000_000,
    });
    // Bind without a secret so the guard carries a hash but no issuer proof.
    const bound = bindAutoSlippageGuardToCall(guard, { chainId: 8453, venue: VENUE, data, secret: "" });
    const route = {
      provider: "lifi",
      chainId: 8453,
      calldataReady: true,
      transaction: { chainId: 8453, to: VENUE, data, value: "0", slippageGuard: bound },
    };
    assert.throws(
      () => assertPreparedProtocolRoute(route, { provider: "lifi", chainId: 8453, nowMs: 1_001_000 }),
      /attestation secret required|ORACLE_ROUTE_ATTESTATION_SECRET required/,
    );
  });
});

test("secret scanner has no whole-file exemptions for key-handling tests", () => {
  const scanner = fs.readFileSync(path.join(ROOT, "scripts/secret-scan.mjs"), "utf8");
  for (const rel of [
    "test\\/public-api-connect-agent\\.test\\.mjs",
    "test\\/key-vault\\.test\\.mjs",
    "test\\/hl-exec\\.test\\.mjs",
  ]) {
    assert.equal(scanner.includes(rel), false, `${rel} must not be path-exempt`);
  }
});

test("prepare package deep imports refuse broadcast and cow submit/sign", async () => {
  const { btcBroadcast } = await import("../src/data/providers/bitcoin-esplora.mjs");
  await assert.rejects(() => btcBroadcast({ execute: true, txHex: "00" }), /prepare-only|refused/i);
  const cow = await import("../src/data/providers/cowswap.mjs");
  await assert.rejects(() => cow.cowSubmitSignedOrder({}), /prepare-only|refused/i);
  await assert.rejects(() => cow.cowSignOrder({}), /prepare-only|refused/i);
  await assert.rejects(() => cow.cowSignCancel({}), /prepare-only|refused/i);
});

test("prepare package refuses all settle deep-imports (absolute)", async () => {
  const { cowCancelOrders } = await import("../src/data/providers/cowswap.mjs");
  await assert.rejects(() => cowCancelOrders({ orderUids: ["0x" + "ab".repeat(56)], signature: "0x12" }), /prepare-only|refused/i);

  const { rpcCall } = await import("../src/data/providers/evm-rpc.mjs");
  await assert.rejects(
    () => rpcCall(1, "eth_sendRawTransaction", ["0xdead"], { rpcUrl: "https://example.invalid" }),
    /prepare-only|refused|send/i
  );

  const { solanaRpc } = await import("../src/data/providers/solana-rpc.mjs");
  await assert.rejects(() => solanaRpc("sendTransaction", ["AAAA"]), /prepare-only|refused|send/i);

  const { submitUserOperation } = await import("../src/public-control/bundler-client.mjs");
  await assert.rejects(() => submitUserOperation({ userOp: { signature: "0x12" } }), /prepare-only|refused/i);

  const { btcBroadcast } = await import("../src/data/providers/bitcoin-esplora.mjs");
  await assert.rejects(() => btcBroadcast({ execute: true, txHex: "00" }), /prepare-only|refused/i);
});

test("hl prepare stamps oraclePrepared envelope", async () => {
  const { stampPrepared, computePrepareHash, assertPreparedEnvelope } = await import("../src/prepare-envelope.mjs");
  const sample = stampPrepared(
    { action: { type: "order", orders: [] }, nonce: 1, kind: "perp-order" },
    { provider: "hl-perps", kind: "perp-order" }
  );
  assert.equal(sample.oraclePrepared, true);
  assert.equal(sample.prepareHash, computePrepareHash(sample));
  assertPreparedEnvelope(sample);
  sample.action = { type: "order", orders: [{ s: "999" }] };
  assert.throws(() => assertPreparedEnvelope(sample), /prepareHash mismatch/);
});
