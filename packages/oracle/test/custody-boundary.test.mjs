// Custody boundary, asserted on the IMPORT GRAPH and the package surface —
// not on filenames.
//
// The previous version banned a hand-picked list of names ("keystore",
// "exec-server") and omitted the two modules that actually sign: hl-exec and
// key-vault. That is why CI stayed green while the package root exported the
// key vault and root dataCall reached a live signer. A test that enumerates
// forbidden names proves only that those names are absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Resolve a relative import to a real file path, if it is a local module. */
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.mjs`, `${base}.js`, join(base, "index.mjs")]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Every local module transitively reachable from an entrypoint. */
function importGraph(entry) {
  const seen = new Set();
  const stack = [resolve(ROOT, entry)];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const specs = [
      ...src.matchAll(/^\s*import\s+[^'"]*from\s+["']([^"']+)["']/gm),
      ...src.matchAll(/^\s*export\s+[^'"]*from\s+["']([^"']+)["']/gm),
    ].map((m) => m[1]);
    for (const spec of specs) {
      const target = resolveLocal(file, spec);
      if (target) stack.push(target);
    }
  }
  return seen;
}

// Modules that hold key material or sign+submit. Reaching ANY of these from the
// package root means `import "@oracle-agent/oracle"` hands the caller a signer.
const SIGNER_MODULES = [
  "src/key-vault.mjs",
  "src/data/providers/hl-exec.mjs",
];

test("the package root does not transitively import a signer", () => {
  const graph = importGraph("src/index.mjs");
  const leaked = SIGNER_MODULES.filter((m) => graph.has(resolve(ROOT, m)));
  assert.deepEqual(
    leaked,
    [],
    `package root reaches signer module(s): ${leaked.join(", ")} — execution must require an explicit subpath import`
  );
});

test("the package root exports no key-material function", () => {
  const src = readFileSync(resolve(ROOT, "src/index.mjs"), "utf8");
  for (const name of ["encryptKey", "decryptKey", "readKeyMaterial", "writeVault", "rekeyVault"]) {
    assert.ok(
      !new RegExp(`\\b${name}\\b`).test(src),
      `src/index.mjs must not export ${name}: importing the package root would expose key handling`
    );
  }
});

test("dataCall refuses execution providers", async () => {
  const { dataCall, isExecutionProvider } = await import("../src/data/desk-data.mjs");
  assert.equal(isExecutionProvider("hl-exec"), true);
  await assert.rejects(
    () => dataCall("hl-exec", "trade", { intent: "order", coin: "BTC", side: "buy", type: "market", size: "0.001" }),
    /execution provider/,
    "root dataCall must not route to a signer — package consumers call this directly"
  );
});

test("public data facade has no execution entrypoint", async () => {
  const mod = await import("../src/data/desk-data.mjs");
  assert.equal(mod.executionCall, undefined, "the public data facade must not export an execution path");
});

// The prepare-only JSON-RPC wall was case-sensitive on the THROW while its own
// detector was case-insensitive, so `eth_SendRawTransaction`, `eth_SignTransaction`,
// and `personal_Sign` entered the guard block, missed the throw, and were
// dispatched to the configured RPC node. Found by the 2026-08-03 opus red-team
// lane. Case variants are asserted here because the canonical lowercase names
// were already covered and stayed green throughout.
test("evm write/sign RPC is refused regardless of method-name case", async () => {
  const { rpcCall } = await import("../src/data/providers/evm-rpc.mjs");

  const reached = [];
  const fetchImpl = async (_url, init) => {
    reached.push(JSON.parse(init.body).method);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x0" }),
      text: async () => '{"jsonrpc":"2.0","id":1,"result":"0x0"}',
    };
  };

  // Table is intentionally broader than the original case-mismatch report:
  // vendor/EIP-5792/ERC-4337 write namespaces and malformed spellings must not
  // reach transport either. This is a public prepare-only surface, not a
  // best-effort denylist of the first seven JSON-RPC names we remembered.
  const mustRefuse = [
    "eth_sendRawTransaction", "eth_SendRawTransaction", "eth_SENDRAWTRANSACTION",
    "eth_sendTransaction", "eth_SendTransaction",
    "eth_sign", "eth_Sign",
    "eth_signTransaction", "eth_SignTransaction",
    "eth_signTypedData_v4", "eth_SignTypedData_v4",
    "personal_sign", "personal_Sign",
    " eth_sendRawTransaction", "\teth_sendRawTransaction",
    "wallet_sendTransaction", "wallet_sendCalls", "mev_sendBundle", "pm_sendUserOperation",
    "alchemy_sendTransaction", "ankr_sendRawTransaction",
    "eth.sendRawTransaction", "eth-sendRawTransaction",
    `eth_s\u0435ndRawTransaction`,
  ];

  for (const method of mustRefuse) {
    await assert.rejects(
      () => rpcCall(1, method, [], { rpcUrl: "https://rpc.invalid/test", fetchImpl }),
      /prepare-only/,
      `${method} must be refused — prepare-only is a case-independent guarantee`
    );
  }

  assert.deepEqual(reached, [], `write/sign RPC reached the transport: ${reached.join(", ")}`);
});

test("case-folding the evm rpc guard does not break reads", async () => {
  const { rpcCall } = await import("../src/data/providers/evm-rpc.mjs");
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x1234" }),
    text: async () => '{"jsonrpc":"2.0","id":1,"result":"0x1234"}',
  });
  for (const method of ["eth_blockNumber", "eth_getBalance", "eth_call", "eth_chainId", "net_version"]) {
    const out = await rpcCall(1, method, [], { rpcUrl: "https://rpc.invalid/test", fetchImpl });
    assert.equal(out, "0x1234", `${method} is a read and must still be dispatched`);
  }
});

test("the shipped package surface is enumerated, not assumed", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  // If these files ship, that is a deliberate decision — subpath-gated, not
  // reachable from the root. Assert the gate exists rather than pretending the
  // files are absent.
  const exportsMap = pkg.exports || {};
  assert.ok(exportsMap["."], "package must declare an explicit root export");
  const rootTarget = typeof exportsMap["."] === "string" ? exportsMap["."] : exportsMap["."].import || exportsMap["."].default;
  assert.match(String(rootTarget), /index\.mjs$/, "root export must be the curated index");
});


test("public desktop mode never resolves a private operator/desk config dir", async () => {
  const prevDesktop = process.env.ORACLE_PUBLIC_DESKTOP;
  const prevCfg = process.env.ORACLE_CONFIG_DIR;
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-desktop-cfg-"));
  process.env.ORACLE_PUBLIC_DESKTOP = "1";
  process.env.ORACLE_CONFIG_DIR = owned;
  try {
    const env = await import(`../src/oracle-env.mjs?desktop=${Date.now()}`);
    assert.equal(env.ORACLE_CONFIG_DIR, owned);
    assert.equal(env.LEGACY_CONFIG_DIR, owned);
    assert.doesNotMatch(env.LEGACY_CONFIG_DIR, /mad-desk/);

    const secret = await import(`../src/attestation-secret.mjs?desktop=${Date.now()}`);
    if (typeof secret.execEnvCandidates === "function") {
      for (const candidate of secret.execEnvCandidates()) {
        assert.doesNotMatch(String(candidate), /mad-desk/);
      }
    }
  } finally {
    if (prevDesktop === undefined) delete process.env.ORACLE_PUBLIC_DESKTOP;
    else process.env.ORACLE_PUBLIC_DESKTOP = prevDesktop;
    if (prevCfg === undefined) delete process.env.ORACLE_CONFIG_DIR;
    else process.env.ORACLE_CONFIG_DIR = prevCfg;
    fs.rmSync(owned, { recursive: true, force: true });
  }
});
