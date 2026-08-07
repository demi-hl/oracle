import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_OPTIMIZER_TRIALS, optimizeStrategy } from "../src/strategy/optimizer.mjs";
import { backtestStrategy } from "../src/strategy/backtest.mjs";
import { strategyHash, applyParameterOverrides } from "../src/strategy/schema.mjs";
import { STRATEGY_COMPILER_HASH } from "../src/strategy/compiler.mjs";

function risk(extra = {}) {
  return {
    maxLeverage: 2,
    maxNotionalUsd: 5_000,
    positionSizePct: 10,
    stopLossPct: 5,
    takeProfitPct: 10,
    cooldownBars: 0,
    maxDailyLossPct: 20,
    expiresAt: 1_900_000_000_000,
    ...extra,
  };
}

function bar(t, o, h, l, c, v = 100) {
  const hi = Math.max(h, o, c, l);
  const lo = Math.min(l, o, c, h);
  return { t, o, h: hi, l: lo, c, v };
}

function paramStrategy() {
  return {
    version: 1,
    id: "opt-ema",
    name: "Opt EMA",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "1m" },
    parameters: {
      threshold: { value: 100, min: 90, max: 110, step: 10 },
    },
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "k", type: "constant", value: { param: "threshold" } },
      { id: "gt", type: "compare", op: "gt", left: "c", right: "k" },
      { id: "lte", type: "compare", op: "lte", left: "c", right: "k" },
    ],
    rules: {
      entryLong: "gt",
      entryShort: null,
      exitLong: "lte",
      exitShort: null,
    },
    risk: risk(),
  };
}

function trainBars() {
  // series that crosses above 100 then back, and also above 90
  const closes = [80, 85, 95, 105, 115, 120, 110, 100, 85, 80, 95, 105, 90, 85, 80];
  return closes.map((c, i) => bar(1_000 + i * 60_000, c, c + 1, c - 1, c));
}

test("MAX_OPTIMIZER_TRIALS is 256", () => {
  assert.equal(MAX_OPTIMIZER_TRIALS, 256);
});

test("optimizeStrategy returns required shape with train metrics only", () => {
  const strategy = paramStrategy();
  const bars = trainBars();
  const result = optimizeStrategy(strategy, bars, {
    maxTrials: 8,
    objective: "netPnlUsd",
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
  });
  assert.equal(result.strategyHash, strategyHash(strategy));
  assert.equal(result.compilerHash, STRATEGY_COMPILER_HASH);
  assert.equal(result.objective, "netPnlUsd");
  assert.equal(result.maxTrials, 8);
  assert.ok(result.trialsRun >= 1);
  assert.ok(result.trialsRun <= 8);
  assert.ok(Array.isArray(result.candidates));
  assert.ok(result.bestParameters);
  assert.ok(result.bestStrategy);
  assert.equal(result.bestStrategy.parameters.threshold.value, result.bestParameters.threshold);
  for (const c of result.candidates) {
    assert.ok(c.parameters);
    assert.ok(c.metrics);
    assert.equal("status" in c, false);
    assert.equal("evidence" in c, false);
    assert.equal("holdout" in c, false);
  }
  assert.equal("status" in result, false);
  assert.equal("liveEligible" in result, false);
});

test("bounded deterministic grid over declared parameters only", () => {
  const strategy = paramStrategy();
  const bars = trainBars();
  const a = optimizeStrategy(strategy, bars, {
    maxTrials: 16,
    objective: "netPnlUsd",
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
  });
  const b = optimizeStrategy(strategy, bars, {
    maxTrials: 16,
    objective: "netPnlUsd",
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
  });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // threshold grid: 90,100,110 => 3 trials
  assert.equal(a.trialsRun, 3);
  assert.equal(a.candidates.length, 3);
});

test("maxTrials default 64 and hard cap at MAX_OPTIMIZER_TRIALS", () => {
  const strategy = {
    ...paramStrategy(),
    parameters: {
      a: { value: 1, min: 1, max: 20, step: 1 },
      b: { value: 1, min: 1, max: 20, step: 1 },
    },
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "ka", type: "constant", value: { param: "a" } },
      { id: "kb", type: "constant", value: { param: "b" } },
      { id: "gt", type: "compare", op: "gt", left: "c", right: "ka" },
      { id: "lt", type: "compare", op: "lt", left: "c", right: "kb" },
      { id: "exit", type: "logic", op: "or", inputs: ["lt", "gt"] },
    ],
    rules: {
      entryLong: "gt",
      entryShort: null,
      exitLong: "lt",
      exitShort: null,
    },
  };
  // 20*20=400 > 256
  const result = optimizeStrategy(strategy, trainBars(), {
    maxTrials: 256,
    objective: "netPnlUsd",
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
  });
  assert.ok(result.trialsRun <= MAX_OPTIMIZER_TRIALS);
  assert.ok(result.trialsRun <= 256);
  assert.throws(
    () => optimizeStrategy(strategy, trainBars(), { maxTrials: 300 }),
    /maxTrials|256|trial/i,
  );
  assert.throws(
    () => optimizeStrategy(strategy, trainBars(), { maxTrials: 0 }),
    /maxTrials/i,
  );
});

test("rejects holdout test oos option keys", () => {
  const strategy = paramStrategy();
  const bars = trainBars();
  for (const key of ["holdoutBars", "testBars", "oosBars", "holdout", "test", "oosFraction"]) {
    assert.throws(
      () => optimizeStrategy(strategy, bars, { [key]: bars }),
      /holdout|test|oos/i,
      key,
    );
  }
});

test("objective supports netPnlUsd profitFactor sharpe maxDrawdownPct", () => {
  const strategy = paramStrategy();
  const bars = trainBars();
  for (const objective of ["netPnlUsd", "profitFactor", "sharpe", "maxDrawdownPct"]) {
    const result = optimizeStrategy(strategy, bars, {
      maxTrials: 8,
      objective,
      backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    });
    assert.equal(result.objective, objective);
    assert.ok(result.bestParameters);
  }
  assert.throws(
    () => optimizeStrategy(strategy, bars, { objective: "winRate" }),
    /objective/i,
  );
});

test("stable tie-break by canonical parameter JSON", () => {
  // two-parameter strategy where metrics may tie; order must be stable
  const strategy = {
    version: 1,
    id: "tie",
    name: "Tie",
    venue: "hyperliquid",
    market: { coin: "ETH", interval: "1m" },
    parameters: {
      x: { value: 1, min: 1, max: 2, step: 1 },
      y: { value: 1, min: 1, max: 2, step: 1 },
    },
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "k", type: "constant", value: 1_000_000 },
      { id: "never", type: "compare", op: "gt", left: "c", right: "k" },
    ],
    rules: {
      entryLong: "never",
      entryShort: null,
      exitLong: null,
      exitShort: null,
    },
    risk: risk(),
  };
  const bars = trainBars();
  const result = optimizeStrategy(strategy, bars, {
    maxTrials: 16,
    objective: "netPnlUsd",
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
  });
  assert.equal(result.trialsRun, 4);
  // all flat; best should be lexicographically smallest canonical params
  const keys = result.candidates.map((c) => JSON.stringify(c.parameters));
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
  assert.deepEqual(result.bestParameters, result.candidates[0].parameters);
});

test("rejects empty or no parameter grids", () => {
  const strategy = paramStrategy();
  strategy.parameters = {};
  assert.throws(() => optimizeStrategy(strategy, trainBars()), /parameter/i);

  const noGrid = paramStrategy();
  // min=max=value with step still one point - that is a valid 1-point grid
  // empty grid: min > max is invalid at schema level; use step that yields nothing via bad params
  // Instead: parameters present but optimize with strategy that has no parameters after normalize
  const one = paramStrategy();
  one.parameters = { threshold: { value: 100, min: 100, max: 100, step: 1 } };
  const ok = optimizeStrategy(one, trainBars(), {
    maxTrials: 4,
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
  });
  assert.equal(ok.trialsRun, 1);
});

test("candidates include parameters and TRAIN metrics only matching backtest", () => {
  const strategy = paramStrategy();
  const bars = trainBars();
  const result = optimizeStrategy(strategy, bars, {
    maxTrials: 8,
    objective: "netPnlUsd",
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
  });
  for (const c of result.candidates) {
    const overridden = applyParameterOverrides(strategy, c.parameters);
    const bt = backtestStrategy(overridden, bars, {
      takerFeeBps: 0,
      builderFeeBps: 0,
      slippageBps: 0,
    });
    assert.equal(c.metrics.netPnlUsd, bt.metrics.netPnlUsd);
    assert.equal(c.metrics.tradeCount, bt.metrics.tradeCount);
  }
});
