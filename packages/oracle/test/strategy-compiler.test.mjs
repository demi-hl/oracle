import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STRATEGY_COMPILER_HASH,
  STRATEGY_COMPILER_VERSION,
  compileStrategy,
} from "../src/strategy/compiler.mjs";
import { strategyHash } from "../src/strategy/schema.mjs";

function risk(extra = {}) {
  return {
    maxLeverage: 5,
    maxNotionalUsd: 1000,
    positionSizePct: 10,
    stopLossPct: 2,
    takeProfitPct: 4,
    cooldownBars: 0,
    maxDailyLossPct: 5,
    expiresAt: 1_900_000_000_000,
    ...extra,
  };
}

function bar(t, o, h, l, c, v = 100) {
  return { t, o, h, l, c, v };
}

/** Synthetic series that produces a clean EMA(3)/EMA(5) cross up. */
function emaCrossBars() {
  // Long downtrend then sharp up so fast EMA crosses above slow.
  const closes = [
    50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36,
    35, 34, 33, 32, 31, 30, 29, 28, 27, 26,
    30, 36, 42, 48, 54, 60, 66, 72,
  ];
  return closes.map((c, i) => {
    const o = c;
    const h = c + 1;
    const l = c - 1;
    return bar(1_700_000_000_000 + i * 60_000, o, h, l, c, 1000 + i);
  });
}

const emaCrossStrategy = {
  version: 1,
  id: "ema-cross",
  name: "EMA Cross",
  venue: "hyperliquid",
  market: { coin: "BTC", interval: "1m" },
  parameters: {
    fast: { value: 3, min: 2, max: 20, step: 1 },
    slow: { value: 5, min: 3, max: 50, step: 1 },
  },
  nodes: [
    { id: "c", type: "input", field: "close" },
    { id: "fastEma", type: "indicator", indicator: "ema", input: "c", period: { param: "fast" } },
    { id: "slowEma", type: "indicator", indicator: "ema", input: "c", period: { param: "slow" } },
    { id: "crossUp", type: "cross", direction: "above", left: "fastEma", right: "slowEma" },
    { id: "crossDown", type: "cross", direction: "below", left: "fastEma", right: "slowEma" },
  ],
  rules: {
    entryLong: "crossUp",
    entryShort: null,
    exitLong: "crossDown",
    exitShort: null,
  },
  risk: risk(),
};

test("EMA crossover produces the expected signal at the exact closed bar", () => {
  const { evaluate, strategy, nodeOrder } = compileStrategy(emaCrossStrategy);
  assert.ok(Object.isFrozen(strategy));
  assert.ok(Array.isArray(nodeOrder));
  assert.ok(nodeOrder.includes("crossUp"));

  const bars = emaCrossBars();
  let firstCross = -1;
  for (let i = 0; i < bars.length; i++) {
    const { signals, values } = evaluate(bars, i);
    assert.equal(typeof signals.entryLong, "boolean");
    assert.equal(typeof signals.entryShort, "boolean");
    assert.equal(typeof signals.exitLong, "boolean");
    assert.equal(typeof signals.exitShort, "boolean");
    assert.equal(signals.entryShort, false);
    assert.equal(signals.exitShort, false);
    if (signals.entryLong && firstCross < 0) firstCross = i;
    if (values.fastEma != null && values.slowEma != null && i > 0) {
      const prev = evaluate(bars, i - 1).values;
      if (prev.fastEma != null && prev.slowEma != null) {
        const crossed =
          prev.fastEma <= prev.slowEma && values.fastEma > values.slowEma;
        assert.equal(signals.entryLong, crossed);
      }
    }
  }
  assert.ok(firstCross > 0, "expected at least one cross up");
});

test("boolean entry/exit rules resolve correctly", () => {
  const strategy = {
    version: 1,
    id: "bool-rules",
    name: "Bool",
    venue: "hyperliquid",
    market: { coin: "ETH", interval: "5m" },
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "k", type: "constant", value: 10 },
      { id: "gt", type: "compare", op: "gt", left: "c", right: "k" },
      { id: "lt", type: "compare", op: "lt", left: "c", right: "k" },
      { id: "notGt", type: "logic", op: "not", inputs: ["gt"] },
      { id: "andBoth", type: "logic", op: "and", inputs: ["gt", "lt"] },
      { id: "orEither", type: "logic", op: "or", inputs: ["gt", "lt"] },
    ],
    rules: {
      entryLong: "gt",
      entryShort: "lt",
      exitLong: "notGt",
      exitShort: "orEither",
    },
    risk: risk(),
  };
  const { evaluate } = compileStrategy(strategy);
  const bars = [
    bar(1, 10, 11, 9, 9, 1),
    bar(2, 9, 12, 8, 12, 1),
    bar(3, 12, 12, 10, 10, 1),
  ];
  const r0 = evaluate(bars, 0);
  assert.equal(r0.signals.entryLong, false); // 9 > 10
  assert.equal(r0.signals.entryShort, true); // 9 < 10
  assert.equal(r0.signals.exitLong, true); // not gt
  assert.equal(r0.signals.exitShort, true); // or

  const r1 = evaluate(bars, 1);
  assert.equal(r1.signals.entryLong, true);
  assert.equal(r1.signals.entryShort, false);
  assert.equal(r1.signals.exitLong, false);
  assert.equal(r1.values.andBoth, false);
  assert.equal(r1.values.orEither, true);

  const r2 = evaluate(bars, 2);
  assert.equal(r2.signals.entryLong, false); // 10 > 10
  assert.equal(r2.signals.entryShort, false);
});

test("no signal on insufficient history", () => {
  const { evaluate } = compileStrategy(emaCrossStrategy);
  const bars = [
    bar(1, 1, 2, 0.5, 1.5),
    bar(2, 1.5, 2.5, 1, 2),
  ];
  const r = evaluate(bars, 1);
  assert.equal(r.signals.entryLong, false);
  assert.equal(r.signals.exitLong, false);
  assert.equal(r.values.fastEma, null);
});

test("changing bars strictly after index cannot alter evaluate(bars,index)", () => {
  const { evaluate } = compileStrategy(emaCrossStrategy);
  const bars = emaCrossBars();
  const idx = Math.min(20, bars.length - 2);
  const a = evaluate(bars, idx);
  const mutated = bars.map((b) => ({ ...b }));
  for (let i = idx + 1; i < mutated.length; i++) {
    mutated[i] = bar(mutated[i].t, 999, 1000, 998, 999, 1);
  }
  const b = evaluate(mutated, idx);
  assert.deepEqual(b.signals, a.signals);
  assert.deepEqual(b.values, a.values);
});

test("first possible crossing is false without prior evaluable values", () => {
  const strategy = {
    version: 1,
    id: "cross-first",
    name: "Cross First",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "1m" },
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "k", type: "constant", value: 5 },
      { id: "x", type: "cross", direction: "above", left: "c", right: "k" },
    ],
    rules: {
      entryLong: "x",
      entryShort: null,
      exitLong: null,
      exitShort: null,
    },
    risk: risk(),
  };
  const { evaluate } = compileStrategy(strategy);
  const bars = [
    bar(1, 4, 5, 3, 4),
    bar(2, 4, 7, 4, 6),
  ];
  // index 0: no prior bar => cross is false even if left>right conceptually
  assert.equal(evaluate(bars, 0).signals.entryLong, false);
  // index 1: 4 <= 5 and 6 > 5 => true
  assert.equal(evaluate(bars, 1).signals.entryLong, true);
});

test("malformed bars reject", () => {
  const { evaluate } = compileStrategy(emaCrossStrategy);
  assert.throws(() => evaluate(null, 0));
  assert.throws(() => evaluate([], 0));
  assert.throws(() => evaluate([bar(1, 1, 2, 0, 1)], -1));
  assert.throws(() => evaluate([bar(1, 1, 2, 0, 1)], 1));
  assert.throws(() =>
    evaluate(
      [
        bar(2, 1, 2, 0, 1),
        bar(1, 1, 2, 0, 1), // t not increasing
      ],
      1
    )
  );
  assert.throws(() => evaluate([bar(1, 1, 0, 2, 1)], 0)); // high < low
  assert.throws(() => evaluate([{ t: 1, o: 1, h: 2, l: 0, c: NaN, v: 1 }], 0));
});

test("parameter override changes only the referenced behavior", () => {
  const bars = emaCrossBars();
  const base = compileStrategy(emaCrossStrategy);
  const overridden = compileStrategy(emaCrossStrategy, { fast: 4 });
  assert.equal(base.strategy.parameters.fast.value, 3);
  assert.equal(overridden.strategy.parameters.fast.value, 4);
  assert.equal(overridden.strategy.parameters.slow.value, 5);

  // Find an index where signals differ due to period change (or at least values differ).
  let differ = false;
  for (let i = 0; i < bars.length; i++) {
    const a = base.evaluate(bars, i);
    const b = overridden.evaluate(bars, i);
    if (a.values.fastEma !== b.values.fastEma) {
      differ = true;
      break;
    }
  }
  assert.ok(differ, "fast EMA series should change when period overrides");
});

test("evaluation does not mutate inputs", () => {
  const bars = emaCrossBars().map((b) => Object.freeze({ ...b }));
  Object.freeze(bars);
  const { evaluate, strategy } = compileStrategy(emaCrossStrategy);
  const snap = JSON.stringify(strategy);
  const before = bars.map((b) => ({ ...b }));
  evaluate(bars, bars.length - 1);
  assert.equal(JSON.stringify(strategy), snap);
  assert.deepEqual(bars.map((b) => ({ ...b })), before);
});

test("compileStrategy return object is frozen", () => {
  const compiled = compileStrategy(emaCrossStrategy);
  assert.ok(Object.isFrozen(compiled));
  assert.ok(Object.isFrozen(compiled.nodeOrder));
});

test("compare ops are strict and null yields false", () => {
  const strategy = {
    version: 1,
    id: "cmp",
    name: "Cmp",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "1m" },
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "sma2", type: "indicator", indicator: "sma", input: "c", period: 2 },
      { id: "eq", type: "compare", op: "eq", left: "c", right: "sma2" },
      { id: "gte", type: "compare", op: "gte", left: "c", right: "sma2" },
    ],
    rules: {
      entryLong: "eq",
      entryShort: "gte",
      exitLong: null,
      exitShort: null,
    },
    risk: risk(),
  };
  const { evaluate } = compileStrategy(strategy);
  const bars = [bar(1, 1, 1, 1, 1), bar(2, 2, 2, 2, 2)];
  const r0 = evaluate(bars, 0);
  assert.equal(r0.values.sma2, null);
  assert.equal(r0.signals.entryLong, false);
  assert.equal(r0.signals.entryShort, false);
});

test("optional fundingRate and openInterest inputs", () => {
  const strategy = {
    version: 1,
    id: "fr",
    name: "FR",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "1h" },
    parameters: {},
    nodes: [
      { id: "fr", type: "input", field: "fundingRate" },
      { id: "oi", type: "input", field: "openInterest" },
      { id: "z", type: "constant", value: 0 },
      { id: "pos", type: "compare", op: "gt", left: "fr", right: "z" },
    ],
    rules: {
      entryLong: "pos",
      entryShort: null,
      exitLong: null,
      exitShort: null,
    },
    risk: risk(),
  };
  const { evaluate } = compileStrategy(strategy);
  const bars = [
    { t: 1, o: 1, h: 1, l: 1, c: 1, v: 1, fundingRate: 0.01, openInterest: 100 },
  ];
  const r = evaluate(bars, 0);
  assert.equal(r.values.fr, 0.01);
  assert.equal(r.values.oi, 100);
  assert.equal(r.signals.entryLong, true);
});

test("compiled strategy carries stable strategy and compiler identities", () => {
  const compiled = compileStrategy(emaCrossStrategy);
  assert.equal(STRATEGY_COMPILER_VERSION, 1);
  assert.match(STRATEGY_COMPILER_HASH, /^[a-f0-9]{64}$/);
  assert.equal(compiled.compilerVersion, STRATEGY_COMPILER_VERSION);
  assert.equal(compiled.compilerHash, STRATEGY_COMPILER_HASH);
  assert.equal(compiled.strategyHash, strategyHash(emaCrossStrategy));
  assert.deepEqual(compiled.requiredSeries, ["close"]);
});

test("evaluateAll matches per-bar evaluation without future leakage", () => {
  const compiled = compileStrategy(emaCrossStrategy);
  const bars = emaCrossBars();
  const all = compiled.evaluateAll(bars);
  assert.equal(all.length, bars.length);
  for (let i = 0; i < bars.length; i++) {
    assert.deepEqual(all[i], compiled.evaluate(bars, i));
  }
  const mutated = bars.map((entry) => ({ ...entry }));
  mutated[mutated.length - 1].c += 1000;
  mutated[mutated.length - 1].h += 1000;
  const beforeLast = bars.length - 2;
  assert.deepEqual(
    compiled.evaluateAll(mutated)[beforeLast],
    all[beforeLast],
  );
});
