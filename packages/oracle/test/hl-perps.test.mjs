// Hyperliquid perps: precision, caps, and the prepare-only boundary.
//
// Hyperliquid rejects orders carrying more precision than the asset allows, and
// a rejected order is indistinguishable from a missed fill at the moment it
// matters. These tests pin the rounding and every guardrail.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatPerpPrice,
  formatPerpSize,
  hlPreparePerpOrder,
  hlPrepareBuilderFeeApproval,
  hlPrepareUpdateLeverage,
  hlPrepareBracketOrder,
  ORACLE_HL_BUILDER_ADDRESS,
  ORACLE_HL_BUILDER_FEE_BPS,
  ORACLE_HL_BUILDER_FEE_TENTHS_BPS,
  ORDER_TYPES,
  TIF,
} from "../src/data/providers/hl-perps.mjs";

const META = [
  { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "PEPE", szDecimals: 0, maxLeverage: 10 }] },
  [
    { markPx: "60000", oraclePx: "60000" },
    { markPx: "0.0000123", oraclePx: "0.0000123" },
  ],
];

const stub = {
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(META),
  }),
};

test("price is clamped to 5 significant figures", () => {
  // szDecimals 0 => 6 decimal places allowed, so sig figs is the binding rule.
  assert.equal(formatPerpPrice("60000.123456789", 0), "60000");
  assert.equal(formatPerpPrice("1234.5678", 0), "1234.6");
  assert.equal(formatPerpPrice("1.23456789", 0), "1.2346");
});

test("the tighter of the two limits wins", () => {
  // szDecimals 5 => only 1 decimal place, which binds before sig figs do.
  assert.equal(formatPerpPrice("1.23456789", 5), "1.2");
});

test("integer prices bypass the significant-figure rule", () => {
  // Hyperliquid allows any integer price regardless of sig figs.
  assert.equal(formatPerpPrice("123456", 5), "123456");
});

test("price also respects the per-asset decimal limit", () => {
  // szDecimals 5 => at most 1 decimal place for perps (6 - 5).
  assert.equal(formatPerpPrice("1.26", 5), "1.3");
});

test("size is rounded to the asset's size precision", () => {
  assert.equal(formatPerpSize("0.0123456", 5), "0.01235");
  assert.equal(formatPerpSize("1.9", 0), "2");
});

test("a size that rounds to zero is refused, not silently sent", () => {
  assert.throws(() => formatPerpSize("0.0000001", 5), /rounds to zero/);
});

test("rounding never goes through a float", () => {
  // 1.005 at 2dp is the classic float failure (0.1+0.2 family).
  assert.equal(formatPerpPrice("1.005", 4), "1.01");
});

test("a limit order requires an explicit price", async () => {
  await assert.rejects(
    () => hlPreparePerpOrder({ coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, size: "0.01" }, stub),
    /requires an explicit price/
  );
});

test("a market order is an IOC limit priced within the slippage cap", async () => {
  const o = await hlPreparePerpOrder(
    { coin: "BTC", side: "buy", type: ORDER_TYPES.MARKET, size: "0.01", maxSlippageBps: 50 },
    stub
  );
  assert.equal(o.action.orders[0].t.limit.tif, TIF.IOC);
  // 60000 * 1.005 = 60300, clamped to 5 sig figs.
  assert.equal(Number(o.price) > 60000, true, "a buy must cross upward");
  assert.equal(Number(o.price) <= 60300, true, "but no further than the cap");
});

test("prepared Hyperliquid orders disclose the separate builder fee", async () => {
  const o = await hlPreparePerpOrder(
    { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01" },
    stub,
  );
  assert.equal(ORACLE_HL_BUILDER_ADDRESS, "0x4d47B6757aFd42c3dbd9691b71B43d74Afa4b6b2");
  assert.equal(ORACLE_HL_BUILDER_FEE_BPS, 5);
  assert.equal(ORACLE_HL_BUILDER_FEE_TENTHS_BPS, 50);
  assert.deepEqual(o.action.builder, { b: ORACLE_HL_BUILDER_ADDRESS, f: 50 });
  assert.equal(o.builderFeeBps, 5);
  assert.equal(o.integratorFeeBps, undefined);
});

test("Locals Only does not waive Hyperliquid's separate builder fee", async () => {
  const o = await hlPreparePerpOrder(
    { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01", isHolder: true },
    stub,
  );
  assert.deepEqual(o.action.builder, { b: ORACLE_HL_BUILDER_ADDRESS, f: 50 });
  assert.equal(o.builderFeeBps, 5);
  assert.equal(o.integratorFeeBps, undefined);
});

test("builder approval is prepared for the main wallet and never signed or submitted", () => {
  const prepared = hlPrepareBuilderFeeApproval({ nonce: 1_786_081_000_000 });
  assert.deepEqual(prepared.action, {
    type: "approveBuilderFee",
    builder: ORACLE_HL_BUILDER_ADDRESS,
    maxFeeRate: "0.05%",
    nonce: 1_786_081_000_000,
  });
  assert.match(prepared.note, /main wallet/i);
  assert.equal(prepared.signingReady, false);
  assert.equal(prepared.broadcastReady, false);
  assert.equal(prepared.requiresUserSignature, true);
});

test("slippage above 100 bps is refused", async () => {
  await assert.rejects(
    () => hlPreparePerpOrder({ coin: "BTC", side: "buy", type: ORDER_TYPES.MARKET, size: "0.01", maxSlippageBps: 101 }, stub),
    /exceeds the hard 100 bps cap/
  );
});

test("leverage beyond the asset maximum is refused", async () => {
  await assert.rejects(() => hlPrepareUpdateLeverage({ coin: "BTC", leverage: 41 }, stub), /at most 40x/);
  await assert.rejects(() => hlPrepareUpdateLeverage({ coin: "BTC", leverage: 0 }, stub), /positive integer/);
});

test("margin mode maps to isCross and is explicit", async () => {
  const cross = await hlPrepareUpdateLeverage({ coin: "BTC", leverage: 5, marginMode: "cross" }, stub);
  const iso = await hlPrepareUpdateLeverage({ coin: "BTC", leverage: 5, marginMode: "isolated" }, stub);
  assert.equal(cross.action.isCross, true);
  assert.equal(iso.action.isCross, false);
  await assert.rejects(() => hlPrepareUpdateLeverage({ coin: "BTC", leverage: 5, marginMode: "weird" }, stub), /cross.*isolated/);
});

test("high leverage carries a liquidation warning", async () => {
  const l = await hlPrepareUpdateLeverage({ coin: "BTC", leverage: 40 }, stub);
  assert.match(l.liquidationWarning, /2\.50%/);
  const low = await hlPrepareUpdateLeverage({ coin: "BTC", leverage: 2 }, stub);
  assert.equal(low.liquidationWarning, null);
});

test("a bracket attaches reduce-only TP and SL on the opposite side", async () => {
  const b = await hlPrepareBracketOrder(
    { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01", takeProfitPx: "72000", stopLossPx: "57000", isHolder: true },
    stub
  );
  assert.equal(b.legs, 3);
  assert.equal(b.action.grouping, "normalTpsl");
  assert.deepEqual(b.action.builder, { b: ORACLE_HL_BUILDER_ADDRESS, f: 50 });
  assert.equal(b.builderFeeBps, 5);
  for (const leg of b.action.orders.slice(1)) {
    assert.equal(leg.r, true, "protection legs must be reduce-only");
    assert.equal(leg.b, false, "protection on a long must be a sell");
  }
  assert.equal(b.action.orders[1].t.trigger.tpsl, "tp");
  assert.equal(b.action.orders[2].t.trigger.tpsl, "sl");
});

test("a bracket with no protection is refused", async () => {
  await assert.rejects(
    () => hlPrepareBracketOrder({ coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01" }, stub),
    /needs takeProfitPx and\/or stopLossPx/
  );
});

test("an unlisted coin is refused before anything is built", async () => {
  await assert.rejects(() => hlPreparePerpOrder({ coin: "NOTREAL", side: "buy", price: "1", size: "1" }, stub), /not a listed perp/);
});

test("every prepare result is explicitly not ready to sign or broadcast", async () => {
  const o = await hlPreparePerpOrder({ coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01" }, stub);
  assert.equal(o.signingReady, false);
  assert.equal(o.broadcastReady, false);
  assert.equal(o.executionReady, false);
  assert.equal(o.requiresUserSignature, true);
});

test("hl-perps exports NO submit/sign/broadcast function", async () => {
  const mod = await import("../src/data/providers/hl-perps.mjs");
  const allowed = new Set(["HL_SIGNATURE_CHAIN_ID"]);
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;
    if (allowed.has(name)) continue;
    assert.equal(
      /^(submit|send|sign|broadcast|execute|place)/i.test(name),
      false,
      `hl-perps must not export a write function, found ${name}`
    );
  }
});
