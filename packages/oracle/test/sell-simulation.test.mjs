// Sell simulation: the honeypot guard. These tests encode the real attack
// shapes, not just happy paths.

import { test } from "node:test";
import assert from "node:assert/strict";

import { simulateSell, assertSellable, SELL_SIM } from "../src/sell-simulation.mjs";

const TOKEN = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const BASE = "0x4200000000000000000000000000000000000006";
const IN = "1000000000000000000"; // 1e18

/** quote stub: buy returns `tokens`, sell returns `back`. */
function quoter({ tokens, back, sellThrows = false, buyThrows = false }) {
  return async ({ side }) => {
    if (side === "buy") {
      if (buyThrows) throw new Error("no route");
      return { outAmount: tokens };
    }
    if (sellThrows) throw new Error("execution reverted: TRANSFER_FAILED");
    return { outAmount: back };
  };
}

test("a normal token round-trips within fees and reads SAFE", async () => {
  const r = await simulateSell(
    { token: TOKEN, base: BASE, amountIn: IN, chainId: 8453 },
    { quote: quoter({ tokens: "500000000", back: "994000000000000000" }) }
  );
  assert.equal(r.status, SELL_SIM.SAFE);
  assert.equal(r.safe, true);
  assert.ok(r.roundTripLossBps < 100);
});

test("a token that buys but CANNOT sell is flagged HONEYPOT", async () => {
  const r = await simulateSell(
    { token: TOKEN, base: BASE, amountIn: IN },
    { quote: quoter({ tokens: "500000000", sellThrows: true }) }
  );
  assert.equal(r.status, SELL_SIM.HONEYPOT);
  assert.equal(r.tradable, false);
  assert.match(r.reason, /SELL leg fails/);
});

test("a sell that returns zero is a honeypot, not a rounding artifact", async () => {
  const r = await simulateSell(
    { token: TOKEN, base: BASE, amountIn: IN },
    { quote: quoter({ tokens: "500000000", back: "0" }) }
  );
  assert.equal(r.status, SELL_SIM.HONEYPOT);
});

test("a 90% sell tax is caught even though both legs quote fine", async () => {
  const r = await simulateSell(
    { token: TOKEN, base: BASE, amountIn: IN },
    { quote: quoter({ tokens: "500000000", back: "100000000000000000" }) }
  );
  assert.equal(r.status, SELL_SIM.HONEYPOT);
  assert.ok(r.roundTripLossBps >= 5000);
});

test("a 20% round-trip loss is CAUTION — tradable but surfaced", async () => {
  const r = await simulateSell(
    { token: TOKEN, base: BASE, amountIn: IN },
    { quote: quoter({ tokens: "500000000", back: "800000000000000000" }) }
  );
  assert.equal(r.status, SELL_SIM.CAUTION);
  assert.equal(r.tradable, true);
});

test("no buy route at all is UNKNOWN, never SAFE", async () => {
  const r = await simulateSell(
    { token: TOKEN, base: BASE, amountIn: IN },
    { quote: quoter({ buyThrows: true }) }
  );
  assert.equal(r.status, SELL_SIM.UNKNOWN);
  assert.equal(r.safe, false, "unverified must never read as safe");
});

test("assertSellable REFUSES a honeypot and attaches the evidence", async () => {
  await assert.rejects(
    () => assertSellable({ token: TOKEN, base: BASE, amountIn: IN }, { quote: quoter({ tokens: "5", sellThrows: true }) }),
    (err) => err.sellSim?.status === SELL_SIM.HONEYPOT && /sell-sim HONEYPOT/.test(err.message)
  );
});

test("assertSellable fails CLOSED on UNKNOWN by default", async () => {
  await assert.rejects(
    () => assertSellable({ token: TOKEN, base: BASE, amountIn: IN }, { quote: quoter({ buyThrows: true }) }),
    /sell-sim UNKNOWN/
  );
});

test("UNKNOWN can be allowed explicitly for research surfaces", async () => {
  const r = await assertSellable(
    { token: TOKEN, base: BASE, amountIn: IN },
    { quote: quoter({ buyThrows: true }), allowUnknown: true }
  );
  assert.equal(r.status, SELL_SIM.UNKNOWN);
});

test("caution can be refused when the caller wants only clean exits", async () => {
  await assert.rejects(
    () =>
      assertSellable(
        { token: TOKEN, base: BASE, amountIn: IN },
        { quote: quoter({ tokens: "5", back: "800000000000000000" }), allowCaution: false }
      ),
    /sell-sim CAUTION/
  );
});

test("the sell leg is quoted with the ACTUAL tokens the buy would yield", async () => {
  let sellAmount = null;
  await simulateSell(
    { token: TOKEN, base: BASE, amountIn: IN },
    {
      quote: async ({ side, amount }) => {
        if (side === "buy") return { outAmount: "123456789" };
        sellAmount = amount;
        return { outAmount: "990000000000000000" };
      },
    }
  );
  assert.equal(sellAmount, "123456789", "must sell what the buy produced, not a guess");
});

test("garbage quote output is UNKNOWN rather than a false SAFE", async () => {
  const r = await simulateSell(
    { token: TOKEN, base: BASE, amountIn: IN },
    { quote: async () => ({ outAmount: "not-a-number" }) }
  );
  assert.equal(r.status, SELL_SIM.UNKNOWN);
});
