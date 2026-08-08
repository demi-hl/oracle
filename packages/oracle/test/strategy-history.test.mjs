import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchHyperliquidStrategyBars,
  intervalToMs,
  normalizeHyperliquidCandles,
} from "../src/strategy/history.mjs";

test("normalizes, sorts, and deduplicates closed Hyperliquid candles", () => {
  const rows = [
    { t: 120, T: 179, o: "2", h: "4", l: "1", c: "3", v: "20" },
    { t: 60, T: 119, o: "1", h: "3", l: "0.5", c: "2", v: "10" },
    { t: 120, T: 179, o: "2", h: "4", l: "1", c: "3", v: "20" },
    { t: 180, T: 239, o: "3", h: "5", l: "2", c: "4", v: "30" },
  ];
  assert.deepEqual(normalizeHyperliquidCandles(rows, { endTime: 200 }), [
    { t: 60, o: 1, h: 3, l: 0.5, c: 2, v: 10 },
    { t: 120, o: 2, h: 4, l: 1, c: 3, v: 20 },
  ]);
});

test("rejects conflicting duplicate candles at one timestamp", () => {
  assert.throws(
    () => normalizeHyperliquidCandles([
      { t: 60, T: 119, o: "1", h: "3", l: "0.5", c: "2", v: "10" },
      { t: 60, T: 119, o: "1", h: "4", l: "0.5", c: "2", v: "10" },
    ], { endTime: 200 }),
    /conflicting duplicate/i,
  );
});

test("rejects malformed candle data instead of silently fabricating bars", () => {
  assert.throws(
    () => normalizeHyperliquidCandles([{ t: 1, T: 2, o: "x", h: "2", l: "0", c: "1", v: "1" }]),
    /finite/,
  );
  assert.throws(() => normalizeHyperliquidCandles(null), /array/);
});

test("interval conversion covers the strategy schema vocabulary", () => {
  assert.equal(intervalToMs("1m"), 60_000);
  assert.equal(intervalToMs("15m"), 900_000);
  assert.equal(intervalToMs("4h"), 14_400_000);
  assert.equal(intervalToMs("1d"), 86_400_000);
  assert.throws(() => intervalToMs("7m"), /unsupported/);
});

test("fetches candles through the existing Hyperliquid info provider", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.type === "fundingHistory") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          { coin: "BTC", fundingRate: "0.0001", premium: "0", time: 150 },
        ]),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { t: 100, T: 199, o: "1", h: "2", l: "0.5", c: "1.5", v: "3" },
      ]),
    };
  };
  const result = await fetchHyperliquidStrategyBars(
    { coin: "BTC", interval: "1m", startTime: 0, endTime: 200 },
    { fetchImpl },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    type: "candleSnapshot",
    req: { coin: "BTC", interval: "1m", startTime: 0, endTime: 200 },
  });
  assert.deepEqual(calls[1], {
    type: "fundingHistory",
    coin: "BTC",
    startTime: 0,
    endTime: 200,
  });
  assert.deepEqual(result.bars, [
    {
      t: 100,
      o: 1,
      h: 2,
      l: 0.5,
      c: 1.5,
      v: 3,
      fundingRate: 0.0001,
      fundingPaymentRate: 0.0001,
    },
  ]);
  assert.deepEqual(result.range, { startTime: 0, endTime: 200 });
});

test("funding pagination fails closed instead of returning a partial cost history", async () => {
  let fundingCalls = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.type === "candleSnapshot") {
      return { ok: true, status: 200, text: async () => "[]" };
    }
    fundingCalls += 1;
    const rows = Array.from({ length: 500 }, (_, index) => ({
      coin: "BTC",
      fundingRate: "0.0001",
      premium: "0",
      time: body.startTime + index,
    }));
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };
  await assert.rejects(
    () => fetchHyperliquidStrategyBars(
      { coin: "BTC", interval: "1d", startTime: 1, endTime: 100_000 },
      { fetchImpl },
    ),
    /bounded funding history limit/i,
  );
  assert.equal(fundingCalls, 16);
});

test("history requires an explicit deterministic endTime", async () => {
  let called = false;
  await assert.rejects(
    () => fetchHyperliquidStrategyBars(
      { coin: "BTC", interval: "1m", count: 20 },
      { fetchImpl: async () => { called = true; } },
    ),
    /endTime is required/i,
  );
  assert.equal(called, false);
});

test("default range is deterministic from explicit endTime and bars count", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => "[]" };
  };
  const endTime = 50_000_000;
  await fetchHyperliquidStrategyBars(
    { coin: "ETH", interval: "5m", endTime, count: 100 },
    { fetchImpl },
  );
  const candle = bodies.find((body) => body.type === "candleSnapshot");
  assert.equal(candle.req.startTime, endTime - 100 * 300_000);
  assert.equal(candle.req.endTime, endTime);
});
