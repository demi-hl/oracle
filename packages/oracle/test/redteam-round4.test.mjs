// Round-4 regressions (Grok 4.5, final pre-release audit).
//
// Five money-bounding defects that survived three earlier audit rounds. Each
// test is the reproduction, not a paraphrase of it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { enforceTxPolicy } from "../src/exec-policy.mjs";
import { SWAP_VENUES } from "../src/venues.mjs";
import { createApprovalGuard } from "../src/approval-guard.mjs";
import { createSessionGrant, PROVIDERS } from "../src/public-control/session-key-model.mjs";
import { hlPreparePerpOrder, hlPrepareUpdateIsolatedMargin } from "../src/data/providers/hl-perps.mjs";
import { exactBigInt, toScaledInteger } from "../src/exact-integer.mjs";

const VENUE = SWAP_VENUES?.[8453]?.[0] || "0x2626664c2603336E57B271c5C0b26F421741e481";

function meta(markPx, szDecimals = 0, name = "T") {
  return {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify([
        { universe: [{ name, szDecimals, maxLeverage: 40 }] },
        [{ markPx }],
      ]),
    }),
  };
}

test("an unparseable native value is a policy error, not zero", () => {
  // toWei() returned 0n on parse failure, so a huge decimal was scored as
  // value=0 and sailed past every per-tx and daily ceiling.
  assert.throws(
    () => enforceTxPolicy({ chainId: 8453, to: VENUE, value: "999999999999999999999999.5", data: "0x" }, "sign"),
    /cannot interpret|not an exact integer/
  );
});

test("legitimate wei values still pass policy", () => {
  assert.doesNotThrow(() =>
    enforceTxPolicy({ chainId: 8453, to: VENUE, value: "1000000000000000", data: "0x" }, "sign")
  );
});

test("an approval cap above 2^53 is refused rather than rounded up", () => {
  // 9007199254740995 arrives as ...996: one token more than written.
  assert.throws(
    () =>
      createApprovalGuard({
        chainId: 1,
        token: "0x3333333333333333333333333333333333333333",
        spender: "0x1111111111111111111111111111111111111111",
        amount: 9007199254740995,
        nowMs: 1000,
        ttlMs: 10000,
      }),
    /safe integer precision/
  );
});

test("the same approval cap as a string is preserved exactly", () => {
  const g = createApprovalGuard({
    chainId: 1,
    token: "0x3333333333333333333333333333333333333333",
    spender: "0x1111111111111111111111111111111111111111",
    amount: "9007199254740995",
    nowMs: 1000,
    ttlMs: 10000,
  });
  assert.equal(g.amount, "9007199254740995");
});

test("a session wei cap above 2^53 is refused rather than widened", () => {
  const base = {
    provider: PROVIDERS.SAFE,
    owner: "0x1111111111111111111111111111111111111111",
    agent: "0x2222222222222222222222222222222222222222",
    chainId: 1,
    actions: ["erc20:transfer"],
    targets: ["0x3333333333333333333333333333333333333333"],
    expiresAtMs: Date.now() + 60_000,
  };
  assert.throws(() => createSessionGrant({ ...base, maxValueWei: 9007199254740995 }), /safe integer precision/);
  const g = createSessionGrant({ ...base, maxValueWei: "9007199254740995" });
  assert.equal(g.maxValueWei, "9007199254740995");
});

test("tick rounding cannot push a market order past its slippage cap", async () => {
  // mark 0.0012345 at 100 bps rounded UP to 0.001247 = 101.26 bps.
  const o = await hlPreparePerpOrder(
    { coin: "T", side: "buy", type: "market", size: "1", maxSlippageBps: 100 },
    meta("0.0012345")
  );
  const realised = (Number(o.price) / 0.0012345 - 1) * 10_000;
  assert.ok(realised <= 100.0001, `realised ${realised.toFixed(2)} bps exceeds the 100 bps cap`);
  assert.ok(realised > 0, "a buy must still cross the book");
});

test("the sell side is bounded in the opposite direction", async () => {
  const o = await hlPreparePerpOrder(
    { coin: "T", side: "sell", type: "market", size: "1", maxSlippageBps: 100 },
    meta("0.0012345")
  );
  const realised = (1 - Number(o.price) / 0.0012345) * 10_000;
  assert.ok(realised <= 100.0001, `realised ${realised.toFixed(2)} bps exceeds the cap`);
  assert.ok(realised > 0, "a sell must still cross the book");
});

test("normal-magnitude market orders are unaffected", async () => {
  const o = await hlPreparePerpOrder(
    { coin: "T", side: "buy", type: "market", size: "0.01", maxSlippageBps: 50 },
    meta("60000", 5)
  );
  const realised = (Number(o.price) / 60000 - 1) * 10_000;
  assert.ok(realised > 0 && realised <= 50.0001, `realised ${realised.toFixed(2)} bps`);
});

test("isolated-margin scaling does not depend on numeric magnitude", async () => {
  // padEnd() sized the result from Math.trunc(Number(text)), so a leading zero
  // scaled the posted margin 10x too small.
  const m = meta("60000", 5, "BTC");
  const a = await hlPrepareUpdateIsolatedMargin({ coin: "BTC", usd: "1.5" }, m);
  const b = await hlPrepareUpdateIsolatedMargin({ coin: "BTC", usd: "01.5" }, m);
  const c = await hlPrepareUpdateIsolatedMargin({ coin: "BTC", usd: "001" }, m);
  assert.equal(a.action.ntli, 1_500_000);
  assert.equal(b.action.ntli, 1_500_000, "a leading zero must not change the scale");
  assert.equal(c.action.ntli, 1_000_000);
});

test("exactBigInt refuses every lossy shape", () => {
  assert.throws(() => exactBigInt(9007199254740995, "x"), /safe integer/);
  assert.throws(() => exactBigInt(1.5, "x"), /integer/);
  assert.throws(() => exactBigInt("1e3", "x"), /integer/);
  assert.throws(() => exactBigInt("abc", "x"), /integer/);
  assert.equal(exactBigInt("9007199254740995", "x"), 9007199254740995n);
  assert.equal(exactBigInt(9007199254740995n, "x"), 9007199254740995n);
  assert.equal(exactBigInt(42, "x"), 42n);
});

test("toScaledInteger is exact and magnitude-independent", () => {
  assert.equal(toScaledInteger("1.5", 6), 1_500_000n);
  assert.equal(toScaledInteger("01.5", 6), 1_500_000n);
  assert.equal(toScaledInteger("0.000001", 6), 1n);
  assert.equal(toScaledInteger("1", 6), 1_000_000n);
  assert.throws(() => toScaledInteger("1.0000001", 6), /decimal places/);
});
