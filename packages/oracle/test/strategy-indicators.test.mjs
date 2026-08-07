import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, macd, bollinger, atr } from "../src/strategy/indicators.mjs";

function assertClose(actual, expected, eps = 1e-9) {
  if (expected === null) {
    assert.equal(actual, null);
    return;
  }
  assert.equal(typeof actual, "number");
  assert.ok(Number.isFinite(actual), `expected finite, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !~ ${expected}`);
}

test("sma exact known vector", () => {
  const values = [1, 2, 3, 4, 5];
  const out = sma(values, 3);
  assert.equal(out.length, 5);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assertClose(out[2], 2);
  assertClose(out[3], 3);
  assertClose(out[4], 4);
});

test("ema seeds with SMA of first period then smooths", () => {
  const values = [1, 2, 3, 4, 5, 6];
  const out = ema(values, 3);
  assert.equal(out.length, 6);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assertClose(out[2], 2); // SMA(1,2,3)
  // k = 2/(3+1) = 0.5
  assertClose(out[3], 0.5 * 4 + 0.5 * 2); // 3
  assertClose(out[4], 0.5 * 5 + 0.5 * 3); // 4
  assertClose(out[5], 0.5 * 6 + 0.5 * 4); // 5
});

test("rsi exact known vector and zero-gain/loss windows", () => {
  // Classic ramp: gains only after first bar.
  const up = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const outUp = rsi(up, 5);
  assert.equal(outUp.length, up.length);
  assert.equal(outUp[4], null); // need period gains => index period
  // All gains, zero losses => RSI = 100
  for (let i = 5; i < outUp.length; i++) assertClose(outUp[i], 100);

  const flat = [5, 5, 5, 5, 5, 5, 5, 5];
  const outFlat = rsi(flat, 3);
  // zero gain and zero loss => 100 by Wilder convention (avgGain=0, avgLoss=0)
  // Spec: finite and deterministic. Common convention: 50 or 100. We use 50 when both zero.
  for (let i = 3; i < outFlat.length; i++) {
    assert.ok(Number.isFinite(outFlat[i]));
    assert.equal(outFlat[i], outFlat[3]);
  }

  const down = [10, 9, 8, 7, 6, 5, 4];
  const outDown = rsi(down, 3);
  for (let i = 3; i < outDown.length; i++) assertClose(outDown[i], 0);
});

test("macd exact known vector", () => {
  const values = [];
  for (let i = 1; i <= 40; i++) values.push(i);
  const out = macd(values, { fastPeriod: 3, slowPeriod: 5, signalPeriod: 3 });
  assert.equal(out.line.length, values.length);
  assert.equal(out.signal.length, values.length);
  assert.equal(out.histogram.length, values.length);
  // Before slow EMA is ready, line is null.
  assert.equal(out.line[3], null);
  assert.ok(out.line[4] !== null);
  // line = emaFast - emaSlow
  const fast = ema(values, 3);
  const slow = ema(values, 5);
  for (let i = 0; i < values.length; i++) {
    if (fast[i] == null || slow[i] == null) assert.equal(out.line[i], null);
    else assertClose(out.line[i], fast[i] - slow[i]);
  }
  // signal is EMA of line over non-null segment; histogram = line - signal
  for (let i = 0; i < values.length; i++) {
    if (out.line[i] == null || out.signal[i] == null) {
      assert.equal(out.histogram[i], null);
    } else {
      assertClose(out.histogram[i], out.line[i] - out.signal[i]);
    }
  }
});

test("bollinger uses population standard deviation", () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  const out = bollinger(values, { period: 4, stdDev: 2 });
  assert.equal(out.middle.length, values.length);
  assert.equal(out.upper[0], null);
  assert.equal(out.middle[3], 3.5); // (2+4+4+4)/4
  // population variance of [2,4,4,4]: mean 3.5, diffs -1.5,0.5,0.5,0.5
  // var = (2.25+0.25+0.25+0.25)/4 = 3/4 = 0.75, std = sqrt(0.75)
  const std = Math.sqrt(0.75);
  assertClose(out.upper[3], 3.5 + 2 * std);
  assertClose(out.lower[3], 3.5 - 2 * std);
});

test("atr uses true range and Wilder smoothing after SMA seed", () => {
  const bars = [
    { o: 10, h: 12, l: 9, c: 11 },
    { o: 11, h: 13, l: 10, c: 12 },
    { o: 12, h: 14, l: 11, c: 13 },
    { o: 13, h: 15, l: 12, c: 14 },
    { o: 14, h: 16, l: 13, c: 15 },
  ];
  const out = atr(bars, 3);
  assert.equal(out.length, bars.length);
  assert.equal(out[1], null);
  // TR0 = h-l = 3; TR1=max(3,|13-11|,|10-11|)=max(3,2,1)=3; TR2=max(3,|14-12|,|11-12|)=3
  // SMA seed at index 2 = 3
  assertClose(out[2], 3);
  // Wilder: atr = (prev*(period-1) + tr) / period
  // TR3 = max(3, |15-13|, |12-13|) = 3
  assertClose(out[3], (3 * 2 + 3) / 3);
  assertClose(out[4], (out[3] * 2 + 3) / 3);
});

test("insufficient history returns nulls", () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
  assert.deepEqual(ema([1, 2], 5), [null, null]);
  assert.deepEqual(rsi([1, 2, 3], 5), [null, null, null]);
});

test("malformed numbers and periods reject", () => {
  assert.throws(() => sma([1, NaN, 3], 2));
  assert.throws(() => sma([1, 2, 3], 0));
  assert.throws(() => sma([1, 2, 3], 1.5));
  assert.throws(() => ema("x", 2));
  assert.throws(() => rsi([1, 2], -1));
  assert.throws(() => macd([1, 2, 3], { fastPeriod: 0, slowPeriod: 2, signalPeriod: 2 }));
  assert.throws(() => bollinger([1, 2, 3], { period: 2, stdDev: 0 }));
  assert.throws(() => atr([{ o: 1, h: 2, l: 0, c: 1 }], 0));
  assert.throws(() => atr([{ o: 1, h: 0, l: 2, c: 1 }], 1)); // high < low invalid via TR? still finite - we only require finite numbers
});

test("outputs and inputs are not mutated", () => {
  const values = Object.freeze([1, 2, 3, 4, 5]);
  const copy = [...values];
  const s = sma(values, 2);
  s[0] = 99;
  assert.deepEqual([...values], copy);
  const bars = Object.freeze([
    Object.freeze({ o: 1, h: 2, l: 0.5, c: 1.5 }),
    Object.freeze({ o: 1.5, h: 2.5, l: 1, c: 2 }),
    Object.freeze({ o: 2, h: 3, l: 1.5, c: 2.5 }),
  ]);
  const a = atr(bars, 2);
  a[0] = 99;
  assert.equal(bars[0].h, 2);
});
