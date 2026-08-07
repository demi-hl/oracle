// Hyperliquid agent datapoints: the joins and derived math, against fixed fixtures.
//
// The value of this module is that funding/OI/change math happens ONCE. These
// tests pin that math so a chart and a card can never disagree.

import { test } from "node:test";
import assert from "node:assert/strict";

import { hlMarketDatapoints, hlLeaderboards } from "../src/data/providers/hl-markets.mjs";

// metaAndAssetCtxs shape: [ { universe: [...] }, [ ctx, ... ] ]
const META = [
  {
    universe: [
      { name: "BTC", szDecimals: 5, maxLeverage: 40 },
      { name: "ETH", szDecimals: 4, maxLeverage: 25 },
      { name: "DEAD", szDecimals: 2, maxLeverage: 5, isDelisted: true },
    ],
  },
  [
    { markPx: "100", prevDayPx: "80", openInterest: "10", dayNtlVlm: "5000", funding: "0.0001", oraclePx: "100.5", midPx: "100.1" },
    { markPx: "50", prevDayPx: "100", openInterest: "4", dayNtlVlm: "9000", funding: "-0.00005", oraclePx: "50.1", midPx: "50.05" },
    { markPx: "1", prevDayPx: "1", openInterest: "1", dayNtlVlm: "1", funding: "0" },
  ],
];

function stubFetch() {
  return async (_url, init = {}) => {
    const body = JSON.parse(init.body || "{}");
    const payload = body.type === "metaAndAssetCtxs" ? META : {};
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
  };
}

test("universe and asset contexts are joined by index", async () => {
  const out = await hlMarketDatapoints({}, { fetchImpl: stubFetch() });
  const btc = out.markets.find((m) => m.coin === "BTC");
  assert.equal(btc.markPx, 100);
  assert.equal(btc.maxLeverage, 40, "metadata must come from the universe entry");
  assert.equal(btc.dayNtlVolumeUsd, 5000, "context must come from the matching ctx index");
});

test("delisted markets are excluded from the board", async () => {
  const out = await hlMarketDatapoints({}, { fetchImpl: stubFetch() });
  assert.equal(out.count, 2);
  assert.equal(out.markets.some((m) => m.coin === "DEAD"), false);
});

test("24h change is computed against prevDayPx", async () => {
  const out = await hlMarketDatapoints({}, { fetchImpl: stubFetch() });
  assert.equal(out.markets.find((m) => m.coin === "BTC").change24hPct, 25);
  assert.equal(out.markets.find((m) => m.coin === "ETH").change24hPct, -50);
});

test("open interest is converted from coin units to USD", async () => {
  const out = await hlMarketDatapoints({}, { fetchImpl: stubFetch() });
  const btc = out.markets.find((m) => m.coin === "BTC");
  assert.equal(btc.openInterestCoin, 10);
  assert.equal(btc.openInterestUsd, 1000, "10 coins at $100");
});

test("funding is annualized from the 8-hour rate", async () => {
  const out = await hlMarketDatapoints({}, { fetchImpl: stubFetch() });
  const btc = out.markets.find((m) => m.coin === "BTC");
  // 0.0001 per 8h * 1095 intervals per year * 100 = 10.95%
  assert.equal(btc.fundingRate, 0.0001);
  assert.ok(Math.abs(btc.fundingRateAprPct - 10.95) < 1e-9, `got ${btc.fundingRateAprPct}`);
});

test("negative funding stays negative when annualized", async () => {
  const out = await hlMarketDatapoints({}, { fetchImpl: stubFetch() });
  assert.ok(out.markets.find((m) => m.coin === "ETH").fundingRateAprPct < 0);
});

test("totals sum only live markets", async () => {
  const out = await hlMarketDatapoints({}, { fetchImpl: stubFetch() });
  assert.equal(out.totals.openInterestUsd, 1000 + 200);
  assert.equal(out.totals.dayNtlVolumeUsd, 5000 + 9000);
});

test("leaderboards sort in the right direction", async () => {
  const lb = await hlLeaderboards({ limit: 5 }, { fetchImpl: stubFetch() });
  assert.equal(lb.gainers[0].coin, "BTC", "biggest gainer first");
  assert.equal(lb.losers[0].coin, "ETH", "biggest loser first");
  assert.equal(lb.byVolume[0].coin, "ETH", "highest volume first");
  assert.equal(lb.byOpenInterest[0].coin, "BTC");
  assert.equal(lb.fundingHighest[0].coin, "BTC");
  assert.equal(lb.fundingLowest[0].coin, "ETH");
});

test("missing numeric fields become null rather than NaN", async () => {
  const sparse = [{ universe: [{ name: "X", szDecimals: 2 }] }, [{ markPx: "10" }]];
  const out = await hlMarketDatapoints(
    {},
    {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(sparse),
      }),
    }
  );
  const x = out.markets[0];
  assert.equal(x.change24hPct, null, "no prevDayPx means no change, not NaN");
  assert.equal(x.fundingRateAprPct, null);
  assert.equal(x.openInterestUsd, null);
});
