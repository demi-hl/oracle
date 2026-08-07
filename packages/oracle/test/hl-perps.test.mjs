// Hyperliquid perps: precision, caps, and the prepare-only boundary.
//
// Hyperliquid rejects orders carrying more precision than the asset allows, and
// a rejected order is indistinguishable from a missed fill at the moment it
// matters. These tests pin the rounding and every guardrail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dataCall } from "../src/data/desk-data.mjs";

import {
  formatPerpPrice,
  formatPerpSize,
  hlPreparePerpOrder,
  hlPrepareBuilderApproval,
  hlPrepareUpdateLeverage,
  hlPrepareBracketOrder,
  HL_BUILDER_DEFAULT_FEE_BPS,
  hlBuilderFeeBpsForKind,
  ORDER_TYPES,
  TIF,
} from "../src/data/providers/hl-perps.mjs";

const BUILDER = "0x1111111111111111111111111111111111111111";
const USER = "0x2222222222222222222222222222222222222222";

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

function stubWithBuilderApproval(approvedWire, onRequest = () => {}) {
  return {
    holderBalance: async () => 0n,
    fetchImpl: async (_url, init = {}) => {
      const request = JSON.parse(String(init.body || "{}"));
      if (request.type === "maxBuilderFee") onRequest(request);
      const payload = request.type === "maxBuilderFee" ? approvedWire : META;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(payload),
      };
    },
  };
}

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

test("core perp orders carry the configured 2 bps builder fee", async () => {
  let approvalRequest;
  const o = await hlPreparePerpOrder(
    { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01", user: USER },
    { ...stubWithBuilderApproval(20, (request) => { approvalRequest = request; }), env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER } }
  );
  assert.deepEqual(approvalRequest, { type: "maxBuilderFee", user: USER, builder: BUILDER });
  assert.equal(HL_BUILDER_DEFAULT_FEE_BPS, 2);
  assert.deepEqual(o.action.builder, { b: BUILDER, f: 20 });
  assert.deepEqual(o.builderFee, { address: BUILDER, bps: 2, percent: "0.02%" });
});

test("builder fee tiers are 2 bps perps and 1 bps spot, HIP-3, and HIP-4", () => {
  assert.equal(hlBuilderFeeBpsForKind("perp"), 2);
  assert.equal(hlBuilderFeeBpsForKind("main"), 2);
  assert.equal(hlBuilderFeeBpsForKind("spot"), 1);
  assert.equal(hlBuilderFeeBpsForKind("hip3"), 1);
  assert.equal(hlBuilderFeeBpsForKind("outcome"), 1);
  assert.equal(hlBuilderFeeBpsForKind("hip4"), 1);
  assert.throws(() => hlBuilderFeeBpsForKind("unknown"), /unknown builder fee kind/);
});

test("HIP-4 orders carry the 1 bps tier", async () => {
  const o = await hlPreparePerpOrder(
    { coin: "#1100", side: "buy", type: ORDER_TYPES.LIMIT, price: "0.50", size: "1", user: USER },
    { ...stubWithBuilderApproval(20), env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER } }
  );
  assert.equal(o.assetKind, "outcome");
  assert.deepEqual(o.action.builder, { b: BUILDER, f: 10 });
  assert.equal(o.builderFee.bps, 1);
});

test("builder fees are absent without configuration and for Locals Only holders", async () => {
  const args = { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01" };
  const unconfigured = await hlPreparePerpOrder(args, stub);
  const holder = await hlPreparePerpOrder(args, {
    ...stub,
    env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER },
    isHolder: true,
  });
  assert.equal(unconfigured.action.builder, undefined);
  assert.equal(holder.action.builder, undefined);
  assert.equal(holder.builderFee, null);
  assert.equal(holder.holderExempt, true);
});

test("live Locals Only balance exempts the order without trusting caller input", async () => {
  const o = await hlPreparePerpOrder(
    { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01", user: USER },
    {
      ...stubWithBuilderApproval(20),
      holderBalance: async () => 1n,
      env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER },
    }
  );
  assert.equal(o.action.builder, undefined);
  assert.equal(o.builderFee, null);
  assert.equal(o.holderExempt, true);
  assert.equal(o.holderVerificationStatus, "holder");
  assert.equal(o.builderApprovalRequired, null);
});

test("an unavailable holder check fails closed to no builder fee", async () => {
  const o = await hlPreparePerpOrder(
    { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01", user: USER },
    {
      ...stubWithBuilderApproval(20),
      holderBalance: async () => { throw new Error("rpc unavailable"); },
      env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER },
    }
  );
  assert.equal(o.action.builder, undefined);
  assert.equal(o.builderFee, null);
  assert.equal(o.holderExempt, false);
  assert.equal(o.holderVerificationStatus, "unavailable");
  assert.equal(o.builderApprovalRequired.status, "unavailable");
});

test("a configured order cannot carry a builder fee above its live approval", async () => {
  const o = await hlPreparePerpOrder(
    { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01", user: USER },
    { ...stubWithBuilderApproval(10), env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER } }
  );
  assert.equal(o.action.builder, undefined);
  assert.equal(o.builderFee, null);
  assert.equal(o.builderApprovalRequired.bps, 2);
  assert.equal(o.builderApprovalRequired.approvedFeeBps, 1);
  assert.equal(o.builderApprovalRequired.status, "insufficient");
});

test("builder approval is a separate user-signed artifact capped at 2 bps", () => {
  const approval = hlPrepareBuilderApproval({}, {
    env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER },
    nonce: 1700000000000,
  });
  assert.deepEqual(approval.action, {
    type: "approveBuilderFee",
    hyperliquidChain: "Mainnet",
    signatureChainId: "0x66eee",
    maxFeeRate: "0.02%",
    builder: BUILDER,
    nonce: 1700000000000,
  });
  assert.equal(approval.requiresUserSignature, true);
  assert.equal(approval.signingReady, false);
  assert.equal(approval.broadcastReady, false);
});

test("fractional builder fees preserve tenths-of-bps precision", () => {
  const approval = hlPrepareBuilderApproval({}, {
    env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER, ORACLE_HL_BUILDER_FEE_BPS: "0.1" },
    nonce: 1700000000000,
  });
  assert.equal(approval.action.maxFeeRate, "0.001%");
  assert.equal(approval.builderFee.bps, 0.1);
});

test("builder approval is exposed through the marked prepare data interface", async () => {
  const args = {};
  const approval = await dataCall("hl-perps", "prepareBuilderApproval", args, {
    env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER },
    nonce: 1700000000000,
  });
  assert.equal(args.__oracleStateCreating, true);
  assert.equal(approval.action.type, "approveBuilderFee");
  assert.equal(approval.action.maxFeeRate, "0.02%");
  assert.equal(approval.requiresUserSignature, true);
  assert.equal(approval.broadcastReady, false);
});

test("builder fee configuration fails closed above the perp cap", async () => {
  await assert.rejects(
    () => hlPreparePerpOrder(
      { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01" },
      { ...stub, env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER, ORACLE_HL_BUILDER_FEE_BPS: "11" } }
    ),
    /exceeds the 10 bps cap/
  );
});

test("builder fee configuration cannot exceed the public product tier", async () => {
  await assert.rejects(
    () => hlPreparePerpOrder(
      { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01" },
      { ...stub, env: { ORACLE_HL_BUILDER_ADDRESS: BUILDER, ORACLE_HL_BUILDER_FEE_BPS: "2.1" } }
    ),
    /exceeds the 2 bps product tier/
  );
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
    { coin: "BTC", side: "buy", type: ORDER_TYPES.LIMIT, price: "60000", size: "0.01", takeProfitPx: "72000", stopLossPx: "57000" },
    stub
  );
  assert.equal(b.legs, 3);
  assert.equal(b.action.grouping, "normalTpsl");
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
