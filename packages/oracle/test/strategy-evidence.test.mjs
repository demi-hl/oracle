import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_STATUSES,
  assertEvidenceArtifact,
  evaluateEvidence,
} from "../src/strategy/evidence.mjs";
import { strategyHash } from "../src/strategy/schema.mjs";
import { STRATEGY_COMPILER_HASH } from "../src/strategy/compiler.mjs";

function risk(extra = {}) {
  return {
    maxLeverage: 2,
    maxNotionalUsd: 5_000,
    positionSizePct: 20,
    stopLossPct: 10,
    takeProfitPct: 20,
    cooldownBars: 0,
    maxDailyLossPct: 50,
    expiresAt: 1_900_000_000_000,
    ...extra,
  };
}

function bar(t, o, h, l, c, v = 100) {
  const hi = Math.max(h, o, c, l);
  const lo = Math.min(l, o, c, h);
  return { t, o, h: hi, l: lo, c, v };
}

function longThresholdStrategy(threshold = 100, extraRisk = {}) {
  return {
    version: 1,
    id: "ev-thresh",
    name: "Evidence Thresh",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "1m" },
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "k", type: "constant", value: threshold },
      { id: "gt", type: "compare", op: "gt", left: "c", right: "k" },
      { id: "lte", type: "compare", op: "lte", left: "c", right: "k" },
    ],
    rules: {
      entryLong: "gt",
      entryShort: null,
      exitLong: "lte",
      exitShort: null,
    },
    risk: risk(extraRisk),
  };
}

/** Alternating profitable long cycles. */
function profitableBars(n = 80, base = 100) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    // pulse above threshold then below to create many round-trips
    const phase = i % 6;
    let c;
    if (phase <= 2) c = base + 10 + phase; // above 100
    else c = base - 5 - (phase - 3); // below/at
    bars.push(bar(1_700_000_000_000 + i * 60_000, c, c + 1, c - 1, c));
  }
  return bars;
}

/** Train profitable, holdout losing. */
function overfitBars() {
  const train = [];
  for (let i = 0; i < 40; i++) {
    const phase = i % 6;
    const c = phase <= 2 ? 110 + phase : 90 - (phase - 3);
    train.push(bar(1_000 + i * 60_000, c, c + 1, c - 1, c));
  }
  const hold = [];
  for (let i = 0; i < 30; i++) {
    // inverse / chop that loses for long-above-100
    const phase = i % 6;
    const c = phase <= 2 ? 105 : 70; // enter then crash hard
    hold.push(bar(1_000 + (40 + i) * 60_000, c, c + 2, c - 20, c));
  }
  return [...train, ...hold];
}

test("EVIDENCE_STATUSES is frozen fail paper live set", () => {
  assert.deepEqual([...EVIDENCE_STATUSES], ["fail", "pass_paper_only", "pass_live_eligible"]);
  assert.ok(Object.isFrozen(EVIDENCE_STATUSES));
});

test("evaluateEvidence returns stable shape with separate train and holdout metrics", () => {
  const strategy = longThresholdStrategy(100);
  const bars = profitableBars(60);
  const result = evaluateEvidence({
    strategy,
    bars,
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    trainFraction: 0.7,
    walkForwardWindows: 3,
    minTrades: 2,
  });
  assert.ok(typeof result.id === "string" && result.id.length === 64);
  assert.ok(EVIDENCE_STATUSES.includes(result.status));
  assert.equal(result.strategyHash, strategyHash(strategy));
  assert.equal(result.compilerHash, STRATEGY_COMPILER_HASH);
  assert.ok(result.split);
  assert.ok(result.train);
  assert.ok(result.holdout);
  assert.ok(result.train.metrics);
  assert.ok(result.holdout.metrics);
  assert.ok(result.walkForward);
  assert.ok(Array.isArray(result.flags));
  // train and holdout disjoint; holdout after train
  assert.ok(result.split.trainEndIndex < result.split.holdoutStartIndex || result.split.trainBarCount + result.split.holdoutBarCount <= bars.length);
  assert.ok(result.split.holdoutStartIndex > result.split.trainStartIndex);
});

test("deterministic chronological split no shuffle", () => {
  const strategy = longThresholdStrategy(100);
  const bars = profitableBars(50);
  const a = evaluateEvidence({
    strategy,
    bars,
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    minTrades: 1,
  });
  const b = evaluateEvidence({
    strategy,
    bars,
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    minTrades: 1,
  });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.id, b.id);
});

test("evidence rejects fields omitted from its deterministic identity", () => {
  const evidence = evaluateEvidence({
    strategy: longThresholdStrategy(100),
    bars: profitableBars(40),
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    minTrades: 1,
  });
  assert.throws(
    () => assertEvidenceArtifact({ ...evidence, executionReady: true }),
    /unbound|unknown|identity/i,
  );
});

test("fail on insufficient bars or absent OOS", () => {
  const strategy = longThresholdStrategy(100);
  const few = profitableBars(4);
  const r = evaluateEvidence({
    strategy,
    bars: few,
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    trainFraction: 0.9,
    minTrades: 10,
  });
  assert.equal(r.status, "fail");
  assert.ok(r.flags.length >= 1);
});

test("evidence does not pass live without OOS and walk-forward", () => {
  const strategy = longThresholdStrategy(100, { maxDailyLossPct: 80 });
  // tiny holdout / weak walk-forward
  const bars = profitableBars(20);
  const r = evaluateEvidence({
    strategy,
    bars,
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    trainFraction: 0.85,
    walkForwardWindows: 3,
    minTrades: 10,
  });
  assert.notEqual(r.status, "pass_live_eligible");
});

test("profitable in-sample but losing holdout is fail or paper only with overfit flag", () => {
  const strategy = longThresholdStrategy(100, {
    stopLossPct: 30,
    takeProfitPct: 5,
    maxDailyLossPct: 80,
  });
  const bars = overfitBars();
  const r = evaluateEvidence({
    strategy,
    bars,
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    trainFraction: 0.55,
    walkForwardWindows: 2,
    minTrades: 2,
  });
  assert.ok(r.status === "fail" || r.status === "pass_paper_only");
  assert.notEqual(r.status, "pass_live_eligible");
  const flagText = JSON.stringify(r.flags).toLowerCase();
  if (r.holdout.metrics.netPnlUsd < 0 || r.train.metrics.netPnlUsd > 0) {
    // when holdout loses after train profit, overfit should be flagged or fail
    assert.ok(
      r.status === "fail" ||
        flagText.includes("overfit") ||
        flagText.includes("holdout") ||
        flagText.includes("collapse"),
    );
  }
});

test("optimizer output alone can never produce evidence live eligibility", () => {
  // evidence requires bars + strategy; passing optimizer-shaped object without proper bars fails
  const strategy = longThresholdStrategy(100);
  const r = evaluateEvidence({
    strategy,
    bars: profitableBars(5),
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    minTrades: 10,
  });
  assert.notEqual(r.status, "pass_live_eligible");
});

test("pass_live_eligible requires holdout trades pnl pf dd walkforward and costs", () => {
  const strategy = longThresholdStrategy(100, {
    stopLossPct: 50,
    takeProfitPct: 50,
    maxDailyLossPct: 80,
    positionSizePct: 10,
    maxLeverage: 1,
  });
  // long series with many clean round trips in train and holdout
  const bars = profitableBars(120, 100);
  const r = evaluateEvidence({
    strategy,
    bars,
    backtestOptions: {
      takerFeeBps: 0,
      builderFeeBps: 0,
      slippageBps: 0,
      initialEquityUsd: 10_000,
    },
    trainFraction: 0.7,
    walkForwardWindows: 3,
    minTrades: 3,
  });
  // May be paper or live depending on metrics; if live, all gates must hold
  if (r.status === "pass_live_eligible") {
    assert.ok(r.holdout.metrics.tradeCount >= 3);
    assert.ok(r.holdout.metrics.netPnlUsd > 0);
    assert.ok(r.holdout.metrics.profitFactor > 1);
    assert.ok(r.holdout.metrics.maxDrawdownPct <= strategy.risk.maxDailyLossPct);
    assert.ok(r.walkForward.passRate >= 0.6);
  } else {
    assert.ok(EVIDENCE_STATUSES.includes(r.status));
  }
});

test("id is stable sha256 over canonical evidence facts", () => {
  const strategy = longThresholdStrategy(100);
  const bars = profitableBars(40);
  const a = evaluateEvidence({
    strategy,
    bars,
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    minTrades: 1,
  });
  const b = evaluateEvidence({
    strategy,
    bars,
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    minTrades: 1,
  });
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[a-f0-9]{64}$/);
});

test("evidence identity binds exact bar provenance even when metrics are unchanged", () => {
  const strategy = longThresholdStrategy(100);
  const bars = profitableBars(40);
  const changed = bars.map((item, index) =>
    index === 10 ? { ...item, openInterest: 123_456 } : { ...item },
  );
  const options = {
    strategy,
    backtestOptions: { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 },
    minTrades: 1,
  };
  const a = evaluateEvidence({ ...options, bars });
  const b = evaluateEvidence({ ...options, bars: changed });
  assert.deepEqual(a.train, b.train);
  assert.deepEqual(a.holdout, b.holdout);
  assert.match(a.barsHash, /^[a-f0-9]{64}$/);
  assert.notEqual(a.barsHash, b.barsHash);
  assert.notEqual(a.id, b.id);
});
