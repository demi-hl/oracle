// Desk swap-prepare: unit conversion, input refusal, and custody posture.
//
// Deliberately no live routing here — a network-dependent assertion turns a
// venue outage into a red suite. The live path is exercised by the desk/CLI
// smoke; what must hold unconditionally is the arithmetic and the refusals.

import test from "node:test";
import assert from "node:assert/strict";
import {
  toRawUnits,
  resolveChainId,
  prepareSwapForDesk,
  SwapPrepareError,
} from "../src/desk/swap-prepare.mjs";

const TAKER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

test("decimal amounts convert to raw units without floating point", () => {
  assert.equal(toRawUnits("1", 18), "1000000000000000000");
  assert.equal(toRawUnits("1.5", 6), "1500000");
  assert.equal(toRawUnits("0.000001", 6), "1");

  // The reason this is string math: Number("0.1") * 1e18 is 100000000000000001…
  // and a wrong amountIn silently prepares a transaction for the wrong size.
  assert.equal(toRawUnits("0.1", 18), "100000000000000000");
  assert.equal(toRawUnits("0.3", 18), "300000000000000000");
});

test("non-positive and non-numeric amounts are refused", () => {
  for (const bad of ["0", "-1", "abc", "", "1e18", "0x10"]) {
    assert.throws(() => toRawUnits(bad, 18), SwapPrepareError, `accepted "${bad}"`);
  }
});

test("an amount finer than the token's precision is refused, not truncated", () => {
  // Silently rounding 1.1234567 USDC to 1.123456 would prepare a transaction
  // for an amount the user never asked for.
  assert.throws(() => toRawUnits("1.1234567", 6), SwapPrepareError);
  assert.equal(toRawUnits("1.123456", 6), "1123456");
});

test("chain accepts both numeric id and scanner key", () => {
  assert.equal(resolveChainId("base"), 8453);
  assert.equal(resolveChainId(8453), 8453);
  assert.equal(resolveChainId("8453"), 8453);
  assert.throws(() => resolveChainId("not-a-chain"), SwapPrepareError);
  assert.throws(() => resolveChainId(""), SwapPrepareError);
});

test("prepare refuses to build a transaction without a real taker", async () => {
  // prepareBestRoute itself rejects placeholder/burn takers; this asserts the
  // desk surfaces that as a 400 rather than letting it escape as a 500.
  for (const taker of [undefined, "", "0xnope", "not-an-address"]) {
    await assert.rejects(
      () => prepareSwapForDesk({ chainId: "base", sellSymbol: "USDC", buySymbol: "WETH", sellAmount: "5", taker }),
      (e) => e instanceof SwapPrepareError && e.status === 400,
      `accepted taker ${JSON.stringify(taker)}`,
    );
  }
});

test("prepare refuses a same-asset swap", async () => {
  await assert.rejects(
    () => prepareSwapForDesk({ chainId: "base", sellSymbol: "USDC", buySymbol: "usdc", sellAmount: "5", taker: TAKER }),
    (e) => e instanceof SwapPrepareError && e.status === 400,
  );
});

test("prepare refuses an unresolvable asset before touching the network", async () => {
  await assert.rejects(
    () => prepareSwapForDesk({ chainId: "base", sellSymbol: "NOTAREALTOKEN", buySymbol: "WETH", sellAmount: "5", taker: TAKER }),
    (e) => e instanceof SwapPrepareError && e.status === 400,
  );
});

test("the module never imports a signing or custody path", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/desk/swap-prepare.mjs", import.meta.url), "utf8");
  for (const forbidden of ["signer", "keystore", "privateKey", "wallet.sign", "broadcast"]) {
    assert.equal(
      new RegExp(`import[^;]*${forbidden}`, "i").test(src),
      false,
      `swap-prepare imports ${forbidden}`,
    );
  }
  // Custody posture is stated in the returned shape, not just in comments.
  assert.match(src, /requiresWalletSignature: true/);
  assert.match(src, /backendSigner: false/);
});
