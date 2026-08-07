// Every prepare helper must return a stamped envelope.
//
// Morpho and Pendle shipped bare objects carrying a full `transaction` — no
// preparedAt/expiresAt/prepareHash/oraclePrepared — so a consumer applying the
// package's own documented operator boundary refused them, and mutation
// detection was absent on two real value-moving payloads. Found by the gpt-56
// lane of the 2026-08-03 four-model review.
//
// Asserted structurally over the whole provider surface rather than as a list
// of the two known-bad names: a test enumerating today's offenders proves
// nothing about the next helper someone adds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDERS = resolve(HERE, "../src/data/providers");

/** Slice a function body from its declaration to the next top-level export. */
function functionBody(src, fnName) {
  const start = src.indexOf(`function ${fnName}`);
  if (start === -1) return "";
  const rest = src.slice(start);
  const end = rest.indexOf("\nexport ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

// Helpers that assemble no payload of their own — they delegate to other
// stamped prepare helpers and return that result. Listed explicitly so the
// exemption is a visible decision rather than a silent hole.
const DELEGATING = new Set([
  "nftPrepareList", // routes to opensea/satflow/magiceden prepare helpers
]);

test("every exported prepare helper returns a stamped envelope", () => {
  const unstamped = [];

  for (const file of readdirSync(PROVIDERS).filter((f) => f.endsWith(".mjs"))) {
    const src = readFileSync(join(PROVIDERS, file), "utf8");
    const fns = [...src.matchAll(/export\s+(?:async\s+)?function\s+(\w*[Pp]repare\w*)/g)].map((m) => m[1]);
    if (!fns.length) continue;

    // A module may stamp through a local wrapper (hl-perps uses `stamped()`).
    // Collect any local function whose own body calls stampPrepared, so calling
    // that wrapper counts as stamping. Verified at runtime for all 9 hl-*
    // helpers before this gate was written.
    const wrappers = [...src.matchAll(/function\s+(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((name) => functionBody(src, name).includes("stampPrepared("));
    const wrapperCall = wrappers.length
      ? new RegExp(`return\\s+(?:await\\s+)?(?:${wrappers.join("|")})\\(`)
      : null;

    for (const fn of fns) {
      if (DELEGATING.has(fn)) continue;
      const body = functionBody(src, fn);
      const stamps = body.includes("stampPrepared");
      const viaWrapper = wrapperCall ? wrapperCall.test(body) : false;
      const delegates = /return\s+(?:await\s+)?\w*[Pp]repare\w*\(/.test(body);
      if (!stamps && !viaWrapper && !delegates) unstamped.push(`${file}:${fn}`);
    }
  }

  assert.deepEqual(
    unstamped,
    [],
    `prepare helpers returning an unstamped payload: ${unstamped.join(", ")} — ` +
      `a consumer applying assertPreparedEnvelope refuses these, and they have no mutation detection`
  );
});

test("morpho and pendle prepare results pass the envelope verifier", async () => {
  const { assertPreparedEnvelope } = await import("../src/prepare-envelope.mjs");
  const { morphoPrepareVault } = await import("../src/data/providers/morpho.mjs");
  const { pendlePrepare } = await import("../src/data/providers/pendle.mjs");

  const EVM = "0x1111111111111111111111111111111111111111";
  // tx.to must equal the official Pendle router for this chain — the provider
  // binds the returned target to its own registry.
  const ROUTER = "0x888888888889758F76e7103c6CbF23ABbF58F946";
  const mk = (body) => async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const pendleResult = await pendlePrepare(
    {
      chainId: 42161,
      receiver: EVM,
      inputs: [{ token: EVM, amount: "100" }],
      outputs: [EVM],
    },
    {
      fetchImpl: mk({
        routes: [{ tx: { to: ROUTER, data: `0xa9059cbb${"0".repeat(64)}`, value: "0" }, outputs: [{ amount: "99" }] }],
      }),
    }
  );
  assert.equal(pendleResult.oraclePrepared, true, "pendle prepare must be stamped");
  assert.doesNotThrow(() => assertPreparedEnvelope(pendleResult));
  assert.equal(pendleResult.signingReady, false);
  assert.equal(pendleResult.broadcastReady, false);

  // Mutating the payload after stamping must be detected.
  const tampered = { ...pendleResult, transaction: { ...pendleResult.transaction, to: "0x" + "9".repeat(40) } };
  assert.throws(() => assertPreparedEnvelope(tampered), /prepareHash mismatch/);

  const VAULT = "0x1111111111111111111111111111111111111111";
  const OWNER = "0x2222222222222222222222222222222222222222";
  const ASSET = "0x3333333333333333333333333333333333333333";
  const erc4626 = new Interface([
    "function asset() view returns (address)",
    "function maxDeposit(address owner) view returns (uint256)",
    "function previewDeposit(uint256 assets) view returns (uint256)",
  ]);
  let vaultCall = 0;
  const morphoResult = await morphoPrepareVault(
    { chainId: 8453, action: "deposit", vault: VAULT, owner: OWNER, amount: "100" },
    {
      fetchImpl: mk({
        data: {
          vaults: {
            items: [{
              address: VAULT,
              listed: true,
              asset: { address: ASSET },
              state: { totalAssetsUsd: 1_000_000 },
            }],
          },
        },
      }),
      rpcCall: async () => {
        vaultCall += 1;
        if (vaultCall === 1) return erc4626.encodeFunctionResult("asset", [ASSET]);
        if (vaultCall === 2) return erc4626.encodeFunctionResult("maxDeposit", ["1000"]);
        if (vaultCall === 3) return erc4626.encodeFunctionResult("previewDeposit", ["99"]);
        throw new Error(`unexpected Morpho vault RPC call ${vaultCall}`);
      },
    },
  );
  assert.equal(vaultCall, 3, "morpho prepare must execute all guarded read checks");
  assert.equal(morphoResult.oraclePrepared, true, "morpho prepare must be stamped");
  assert.doesNotThrow(() => assertPreparedEnvelope(morphoResult));
  assert.throws(
    () => assertPreparedEnvelope({ ...morphoResult, transaction: { ...morphoResult.transaction, data: "0xdeadbeef" } }),
    /prepareHash mismatch/,
    "morpho transaction calldata must be inside the stamped hash body",
  );
});
