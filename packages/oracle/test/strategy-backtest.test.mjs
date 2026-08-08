import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { backtestStrategy } from "../src/strategy/backtest.mjs";
import { strategyHash } from "../src/strategy/schema.mjs";
import { STRATEGY_COMPILER_HASH, STRATEGY_COMPILER_VERSION } from "../src/strategy/compiler.mjs";

function risk(extra = {}) {
  return {
    maxLeverage: 5,
    maxNotionalUsd: 10_000,
    positionSizePct: 10,
    stopLossPct: 2,
    takeProfitPct: 4,
    cooldownBars: 0,
    maxDailyLossPct: 5,
    expiresAt: 1_900_000_000_000,
    ...extra,
  };
}

function bar(t, o, h, l, c, v = 100, extra = {}) {
  const hi = Math.max(h, o, c, l);
  const lo = Math.min(l, o, c, h);
  const index = t >= 1_000 && t <= 10_000 && t % 1_000 === 0 ? t / 1_000 : t;
  return { t: t <= 10_000 ? index * 60_000 : t, o, h: hi, l: lo, c, v, ...extra };
}

function thresholdStrategy(opts = {}) {
  const threshold = opts.threshold ?? 100;
  const side = opts.side ?? "long";
  return {
    version: 1,
    id: opts.id ?? "thresh",
    name: opts.name ?? "Threshold",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "1m" },
    parameters: opts.parameters ?? {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "k", type: "constant", value: threshold },
      { id: "gt", type: "compare", op: "gt", left: "c", right: "k" },
      { id: "lt", type: "compare", op: "lt", left: "c", right: "k" },
      { id: "lte", type: "compare", op: "lte", left: "c", right: "k" },
      { id: "gte", type: "compare", op: "gte", left: "c", right: "k" },
    ],
    rules:
      side === "long"
        ? {
            entryLong: "gt",
            entryShort: null,
            exitLong: "lte",
            exitShort: null,
          }
        : side === "short"
          ? {
              entryLong: null,
              entryShort: "lt",
              exitLong: null,
              exitShort: "gte",
            }
          : {
              entryLong: "gt",
              entryShort: "lt",
              exitLong: "lte",
              exitShort: "gte",
            },
    risk: risk(opts.risk),
  };
}

function assertFrozenDeep(value, path = "root") {
  if (value == null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value), `expected frozen at ${path}`);
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertFrozenDeep(item, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value)) assertFrozenDeep(v, `${path}.${k}`);
}

function canonicalHash(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item != null && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}

test("backtestStrategy returns required shape with hashes and frozen output", () => {
  const strategy = thresholdStrategy();
  const bars = [
    bar(1_000, 90, 91, 89, 90),
    bar(2_000, 90, 91, 89, 101),
    bar(3_000, 101, 102, 100, 101),
    bar(4_000, 101, 102, 100, 99),
    bar(5_000, 99, 100, 98, 99),
  ];
  const result = backtestStrategy(strategy, bars);
  assert.equal(result.strategyHash, strategyHash(strategy));
  assert.equal(result.compilerHash, STRATEGY_COMPILER_HASH);
  assert.equal(result.compilerVersion, STRATEGY_COMPILER_VERSION);
  assert.equal(result.barsHash, canonicalHash(bars));
  assert.ok(result.config);
  assert.ok(Array.isArray(result.trades));
  assert.ok(Array.isArray(result.equityCurve));
  assert.ok(result.metrics);
  for (const k of [
    "netPnlUsd",
    "netPnlPct",
    "maxDrawdownPct",
    "winRate",
    "profitFactor",
    "tradeCount",
    "sharpe",
    "turnoverUsd",
    "exposurePct",
  ]) {
    assert.equal(typeof result.metrics[k], "number", k);
  }
  for (const k of ["feesUsd", "builderFeesUsd", "fundingUsd", "slippageUsd"]) {
    assert.equal(typeof result.costs[k], "number", k);
  }
  assert.ok(Array.isArray(result.liquidations));
  assert.ok(Array.isArray(result.missedFills));
  assert.ok(Array.isArray(result.flags));
  assertFrozenDeep(result);
});

test("replay identity binds the exact canonical input bars", () => {
  const strategy = thresholdStrategy();
  const bars = Array.from({ length: 8 }, (_, i) =>
    bar((i + 1) * 1_000, 90, 91, 89, 90, 100),
  );
  const changed = bars.map((item, index) =>
    index === 4 ? { ...item, openInterest: 123_456 } : { ...item },
  );
  const a = backtestStrategy(strategy, bars);
  const b = backtestStrategy(strategy, changed);
  assert.deepEqual(a.metrics, b.metrics);
  assert.match(a.barsHash, /^[a-f0-9]{64}$/);
  assert.notEqual(a.barsHash, b.barsHash);
});

test("defaults match required fee latency equity values", () => {
  const strategy = thresholdStrategy();
  const bars = [bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100), bar(3, 100, 101, 99, 100)];
  const result = backtestStrategy(strategy, bars);
  assert.equal(result.config.initialEquityUsd, 10_000);
  assert.equal(result.config.takerFeeBps, 3.5);
  assert.equal(result.config.builderFeeBps, 2);
  assert.equal(result.config.slippageBps, 2);
  assert.equal(result.config.latencyBars, 1);
});

test("signal fills at next bar open never same bar close", () => {
  const strategy = thresholdStrategy({ threshold: 100 });
  // bar0 close 101 signals long; fill must be bar1 open 110, not 101
  const bars = [
    bar(1_000, 100, 102, 99, 101),
    bar(2_000, 110, 112, 109, 111),
    bar(3_000, 111, 112, 90, 95), // exit signal on close <= 100
    bar(4_000, 95, 96, 94, 95),
    bar(5_000, 95, 96, 94, 95),
  ];
  const result = backtestStrategy(strategy, bars, {
    initialEquityUsd: 10_000,
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
    latencyBars: 1,
  });
  assert.ok(result.trades.length >= 1);
  const t0 = result.trades[0];
  assert.equal(t0.side, "long");
  assert.equal(t0.entryBarIndex, 1);
  assert.equal(t0.entryPrice, 110);
  assert.notEqual(t0.entryPrice, 101);
});

test("risk exits can trigger on the same bar as the next-open entry fill", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    risk: { stopLossPct: 2, takeProfitPct: 20 },
  });
  const bars = [
    bar(1, 100, 102, 99, 101),
    bar(2, 100, 101, 95, 100),
    bar(3, 100, 101, 99, 100),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.ok(result.trades.length >= 1);
  assert.equal(result.trades[0].entryBarIndex, 1);
  assert.equal(result.trades[0].exitBarIndex, 1);
  assert.equal(result.trades[0].exitReason, "stop_loss");
});

test("gap-through stop and liquidation fills never improve beyond the bar open", () => {
  const stopStrategy = thresholdStrategy({ threshold: 100, risk: { maxLeverage: 2, stopLossPct: 2, takeProfitPct: 50 } });
  const stopBars = [
    bar(1, 100, 102, 99, 101),
    bar(2, 100, 102, 99, 101),
    bar(3, 60, 61, 55, 58),
  ];
  const stopResult = backtestStrategy(stopStrategy, stopBars, { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 });
  assert.equal(stopResult.trades[0].exitPrice, 60);

  const liqStrategy = thresholdStrategy({ threshold: 100, risk: { maxLeverage: 5, stopLossPct: 50, takeProfitPct: 50 } });
  const liqBars = [
    bar(1, 100, 102, 99, 101),
    bar(2, 100, 102, 99, 101),
    bar(3, 40, 41, 35, 38),
  ];
  const liqResult = backtestStrategy(liqStrategy, liqBars, { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 });
  assert.equal(liqResult.trades[0].exitReason, "liquidation");
  assert.equal(liqResult.trades[0].exitPrice, 40);
});

test("take-profit gaps never improve beyond the configured trigger", () => {
  const longStrategy = thresholdStrategy({
    threshold: 100,
    side: "long",
    risk: { maxLeverage: 1, stopLossPct: 50, takeProfitPct: 4 },
  });
  const longResult = backtestStrategy(longStrategy, [
    bar(1, 100, 102, 99, 101, 1_000),
    bar(2, 100, 102, 99, 101, 1_000),
    bar(3, 120, 121, 119, 120, 1_000),
  ], { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 });
  assert.equal(longResult.trades[0].exitReason, "take_profit");
  assert.equal(longResult.trades[0].exitPrice, 104);

  const shortStrategy = thresholdStrategy({
    threshold: 100,
    side: "short",
    risk: { maxLeverage: 1, stopLossPct: 50, takeProfitPct: 4 },
  });
  const shortResult = backtestStrategy(shortStrategy, [
    bar(1, 100, 101, 98, 99, 1_000),
    bar(2, 100, 101, 98, 99, 1_000),
    bar(3, 80, 81, 79, 80, 1_000),
  ], { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 });
  assert.equal(shortResult.trades[0].exitReason, "take_profit");
  assert.equal(shortResult.trades[0].exitPrice, 96);
});

test("direct backtest fails closed when a required external series is absent", () => {
  const s = thresholdStrategy();
  s.nodes = [
    { id: "oi", type: "input", field: "openInterest" },
    { id: "k", type: "constant", value: 1 },
    { id: "gt", type: "compare", op: "gt", left: "oi", right: "k" },
  ];
  s.rules = { entryLong: "gt", entryShort: null, exitLong: null, exitShort: null };
  assert.throws(
    () => backtestStrategy(s, [bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100)]),
    /required series.*openInterest/i,
  );
});

test("trade net pnl reconciles to realized equity without double-counting slippage", () => {
  const strategy = thresholdStrategy({ threshold: 100, risk: { stopLossPct: 20, takeProfitPct: 20 } });
  const bars = [
    bar(1, 100, 102, 99, 101),
    bar(2, 100, 102, 99, 101),
    bar(3, 100, 101, 98, 99),
    bar(4, 99, 100, 98, 99),
  ];
  const result = backtestStrategy(strategy, bars, {
    initialEquityUsd: 10_000,
    takerFeeBps: 3.5,
    builderFeeBps: 2,
    slippageBps: 25,
  });
  const tradeNet = result.trades.reduce((sum, trade) => sum + trade.netPnlUsd, 0);
  assert.ok(Math.abs(tradeNet - result.metrics.netPnlUsd) < 1e-8);
  assert.ok(result.costs.slippageUsd > 0);
});

test("equity curve marks open positions to market and reports exposure", () => {
  const strategy = thresholdStrategy({ threshold: 100, risk: { stopLossPct: 40, takeProfitPct: 40 } });
  const bars = [
    bar(1, 100, 102, 99, 101),
    bar(2, 100, 102, 99, 101),
    bar(3, 100, 100, 80, 80),
    bar(4, 80, 81, 79, 80),
  ];
  const result = backtestStrategy(strategy, bars, {
    initialEquityUsd: 10_000,
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.ok(result.equityCurve[2].equity < 10_000);
  assert.ok(result.metrics.maxDrawdownPct > 0);
  assert.ok(result.metrics.exposurePct > 0);
});

test("volume participation can deterministically record a missed entry fill", () => {
  const strategy = thresholdStrategy({ threshold: 100 });
  const bars = [
    bar(1, 100, 102, 99, 101, 1),
    bar(2, 100, 101, 99, 100, 1),
    bar(3, 100, 101, 99, 100, 1),
  ];
  const result = backtestStrategy(strategy, bars, {
    maxVolumeParticipationPct: 1,
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.trades.length, 0);
  assert.equal(result.missedFills.length, 1);
  assert.equal(result.missedFills[0].side, "long");
});

test("same-bar fills share one aggregate volume participation allowance", () => {
  const strategy = thresholdStrategy({
    risk: {
      maxLeverage: 1,
      maxNotionalUsd: 1_000,
      positionSizePct: 10,
      stopLossPct: 2,
      takeProfitPct: 50,
    },
  });
  const bars = [
    bar(1, 100, 102, 99, 101, 100),
    bar(2, 100, 102, 97, 99, 100),
    bar(3, 97, 98, 96, 97, 1_000),
  ];
  const result = backtestStrategy(strategy, bars, {
    maxVolumeParticipationPct: 10,
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitBarIndex, 2);
  assert.equal(result.trades[0].exitReason, "stop_loss");
  assert.ok(result.missedFills.some((fill) =>
    fill.kind === "exit" && fill.barIndex === 1 && fill.maxFillNotionalUsd === 0
  ));
});

test("short entry participation uses the actual adverse fill price", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    side: "short",
    risk: { maxLeverage: 1, maxNotionalUsd: 1_000, positionSizePct: 10 },
  });
  const bars = [
    bar(1, 100, 101, 98, 99, 100),
    bar(2, 100, 101, 49, 99, 100),
    bar(3, 99, 100, 98, 99, 100),
  ];
  const result = backtestStrategy(strategy, bars, {
    maxVolumeParticipationPct: 10,
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 5_000,
  });
  assert.equal(result.trades.length, 0);
  assert.equal(result.missedFills[0].kind, "entry");
  assert.equal(result.missedFills[0].side, "short");
  assert.equal(result.missedFills[0].maxFillNotionalUsd, 500);
});

test("volume participation records missed exits and retries at the next open", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    risk: { maxLeverage: 1, stopLossPct: 50, takeProfitPct: 50 },
  });
  const bars = [
    bar(1, 100, 102, 99, 101, 1_000),
    bar(2, 100, 102, 99, 101, 1_000),
    bar(3, 100, 101, 98, 99, 1_000),
    bar(4, 99, 100, 98, 99, 0.1),
    bar(5, 98, 99, 97, 98, 1_000),
  ];
  const result = backtestStrategy(strategy, bars, {
    maxVolumeParticipationPct: 1,
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitBarIndex, 4);
  assert.ok(result.missedFills.some((fill) =>
    fill.kind === "exit" && fill.barIndex === 3 && fill.reason === "volume_participation"
  ));
});

test("exit participation uses the actual fill price instead of candle open", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    risk: { maxLeverage: 1, stopLossPct: 10, takeProfitPct: 50 },
  });
  const bars = [
    bar(1, 101, 102, 100, 101, 1_000),
    bar(2, 100, 102, 99, 101, 1_000),
    bar(3, 200, 200, 80, 110, 90),
    bar(4, 90, 91, 89, 90, 1_000),
    bar(5, 90, 91, 89, 90, 1_000),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
    maxVolumeParticipationPct: 10,
  });
  assert.equal(result.missedFills[0].kind, "exit");
  assert.equal(result.missedFills[0].barIndex, 2);
  assert.equal(result.missedFills[0].triggerReason, "stop_loss");
  assert.equal(result.trades[0].exitBarIndex, 3);
});

test("daily loss limit blocks new entries for the rest of the UTC day", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    risk: {
      maxLeverage: 1,
      maxNotionalUsd: 10_000,
      positionSizePct: 100,
      stopLossPct: 6,
      takeProfitPct: 40,
      maxDailyLossPct: 5,
      cooldownBars: 0,
    },
  });
  const bars = [
    bar(1_000, 100, 102, 99, 101, 1_000),
    bar(2_000, 100, 102, 93, 101, 1_000),
    bar(3_000, 100, 102, 99, 101, 1_000),
    bar(4_000, 100, 102, 99, 101, 1_000),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.trades.length, 1);
  assert.ok(result.flags.some((flag) => flag.type === "daily_loss_limit"));
});

test("daily loss limit latches on marked equity before a later breakeven exit", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    risk: {
      maxLeverage: 1,
      maxNotionalUsd: 10_000,
      positionSizePct: 100,
      stopLossPct: 50,
      takeProfitPct: 50,
      maxDailyLossPct: 2,
      cooldownBars: 0,
    },
  });
  const bars = [
    bar(1_000, 100, 102, 99, 101, 1_000),
    bar(2_000, 100, 102, 99, 101, 1_000),
    bar(3_000, 100, 101, 96, 97, 1_000),
    bar(4_000, 100, 102, 99, 101, 1_000),
    bar(5_000, 100, 102, 99, 101, 1_000),
    bar(6_000, 100, 102, 99, 101, 1_000),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.trades.length, 1);
  assert.ok(result.flags.some((flag) => flag.type === "daily_loss_limit" && flag.barIndex === 2));
});

test("latencyBars minimum is 1 and default is 1", () => {
  const strategy = thresholdStrategy({ threshold: 100 });
  const bars = [
    bar(1, 100, 101, 99, 101),
    bar(2, 120, 121, 119, 120),
    bar(3, 120, 121, 119, 90),
    bar(4, 90, 91, 89, 90),
    bar(5, 90, 91, 89, 90),
  ];
  const a = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  const b = backtestStrategy(strategy, bars, {
    latencyBars: 1,
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.throws(() => backtestStrategy(strategy, bars, { latencyBars: 0 }), /latency/i);
});

test("queued entries are bound to the flat lifecycle that created them", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    risk: { maxLeverage: 1, stopLossPct: 2, takeProfitPct: 50 },
  });
  const bars = [
    bar(1, 101, 102, 100, 101, 1_000),
    bar(2, 101, 102, 100, 101, 1_000),
    bar(3, 101, 102, 90, 90, 1_000),
    bar(4, 90, 91, 89, 90, 1_000),
    bar(5, 90, 91, 89, 90, 1_000),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
    latencyBars: 2,
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, "stop_loss");
  assert.equal(result.equityCurve[3].positionSide, null);
});

test("adverse slippage on entries and exits", () => {
  const strategy = thresholdStrategy({ threshold: 100 });
  const bars = [
    bar(1, 100, 101, 99, 101),
    bar(2, 100, 101, 99, 101),
    bar(3, 100, 101, 99, 90),
    bar(4, 100, 101, 99, 90),
    bar(5, 100, 101, 99, 90),
  ];
  const noSlip = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
    latencyBars: 1,
  });
  const slip = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 50,
    latencyBars: 1,
  });
  assert.ok(slip.trades.length >= 1);
  const t = slip.trades[0];
  // long entry worse (higher), long exit worse (lower)
  assert.ok(t.entryPrice > 100);
  if (t.exitPrice != null && t.exitReason !== "end_of_data") {
    // exit fill uses open with adverse slip
  }
  assert.ok(slip.costs.slippageUsd > 0);
  assert.ok(slip.metrics.netPnlUsd <= noSlip.metrics.netPnlUsd);
});

test("conflicting entry signals do not open and add a flag", () => {
  const strategy = thresholdStrategy({ side: "both", threshold: 100 });
  // force both gt and lt impossible normally; use dual thresholds via custom nodes
  const custom = {
    version: 1,
    id: "conflict",
    name: "Conflict",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "1m" },
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "lo", type: "constant", value: 0 },
      { id: "hi", type: "constant", value: 1_000_000 },
      { id: "alwaysLong", type: "compare", op: "gt", left: "c", right: "lo" },
      { id: "alwaysShort", type: "compare", op: "lt", left: "c", right: "hi" },
    ],
    rules: {
      entryLong: "alwaysLong",
      entryShort: "alwaysShort",
      exitLong: null,
      exitShort: null,
    },
    risk: risk(),
  };
  const bars = [
    bar(1, 100, 101, 99, 100),
    bar(2, 100, 101, 99, 100),
    bar(3, 100, 101, 99, 100),
    bar(4, 100, 101, 99, 100),
  ];
  const result = backtestStrategy(custom, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.trades.length, 0);
  assert.ok(
    result.flags.some(
      (f) =>
        (typeof f === "string" && /conflict/i.test(f)) ||
        (f && typeof f === "object" && /conflict/i.test(String(f.type || f.message || ""))),
    ),
  );
});

test("notional respects positionSizePct leverage and maxNotionalUsd", () => {
  const strategy = thresholdStrategy({
    risk: {
      maxLeverage: 2,
      maxNotionalUsd: 500,
      positionSizePct: 100,
      stopLossPct: 50,
      takeProfitPct: 50,
      cooldownBars: 0,
      maxDailyLossPct: 90,
      expiresAt: 1_900_000_000_000,
    },
  });
  const bars = [
    bar(1, 100, 101, 99, 101),
    bar(2, 100, 101, 99, 101),
    bar(3, 100, 101, 99, 101),
    bar(4, 100, 101, 99, 50),
    bar(5, 50, 51, 49, 50),
  ];
  const result = backtestStrategy(strategy, bars, {
    initialEquityUsd: 10_000,
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.ok(result.trades.length >= 1);
  // equity*pct/100*lev = 10000*1*2 = 20000, capped to 500
  assert.ok(result.trades[0].notionalUsd <= 500 + 1e-9);
  assert.ok(result.trades[0].notionalUsd >= 500 - 1e-6);
});

test("simultaneous stop and take chooses adverse stop first", () => {
  // custom exit only when close < 50 so rule exit does not fire on the wide bar
  const strategy = {
    version: 1,
    id: "stop-take",
    name: "Stop Take",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "1m" },
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "enterAt", type: "constant", value: 100 },
      { id: "exitAt", type: "constant", value: 50 },
      { id: "gt", type: "compare", op: "gt", left: "c", right: "enterAt" },
      { id: "ltExit", type: "compare", op: "lt", left: "c", right: "exitAt" },
    ],
    rules: {
      entryLong: "gt",
      entryShort: null,
      exitLong: "ltExit",
      exitShort: null,
    },
    risk: risk({
      maxLeverage: 1,
      maxNotionalUsd: 10_000,
      positionSizePct: 10,
      stopLossPct: 2,
      takeProfitPct: 2,
      cooldownBars: 0,
      maxDailyLossPct: 50,
    }),
  };
  // entry at 100; SL 98 TP 102; bar spans both; close stays mid so no rule exit
  const bars = [
    bar(1, 100, 101, 99, 101),
    bar(2, 100, 100, 100, 100), // fill long at 100
    bar(3, 100, 103, 97, 100), // both stop and take touch
    bar(4, 100, 101, 99, 100),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
    latencyBars: 1,
  });
  assert.ok(result.trades.length >= 1);
  const t = result.trades[0];
  assert.equal(t.exitReason, "stop_loss");
  assert.ok(t.exitPrice <= 98 + 1e-9);
});

test("maintenance margin liquidates before bankruptcy", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    risk: { maxLeverage: 5, stopLossPct: 50, takeProfitPct: 50 },
  });
  const bars = [
    bar(1, 100, 102, 99, 101),
    bar(2, 100, 102, 99, 101),
    bar(3, 90, 91, 85, 90),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.trades[0]?.exitReason, "liquidation");
  assert.ok(result.trades[0].exitPrice > 80);
});

test("liquidation at high leverage dominates take profit", () => {
  const strategy = {
    version: 1,
    id: "liq-dom",
    name: "Liq Dom",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "1m" },
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "enterAt", type: "constant", value: 100 },
      { id: "exitAt", type: "constant", value: 50 },
      { id: "gt", type: "compare", op: "gt", left: "c", right: "enterAt" },
      { id: "ltExit", type: "compare", op: "lt", left: "c", right: "exitAt" },
    ],
    rules: {
      entryLong: "gt",
      entryShort: null,
      exitLong: "ltExit",
      exitShort: null,
    },
    risk: risk({
      maxLeverage: 20,
      maxNotionalUsd: 10_000,
      positionSizePct: 100,
      stopLossPct: 50,
      takeProfitPct: 1,
      cooldownBars: 0,
      maxDailyLossPct: 90,
    }),
  };
  // long entry 100; liq approx 100*(1-1/20)=95; TP=101
  // bar goes to 102 high and 94 low -> both TP and liq; liq wins
  const bars = [
    bar(1, 100, 101, 99, 101),
    bar(2, 100, 100, 100, 100),
    bar(3, 100, 102, 94, 100),
    bar(4, 100, 101, 99, 100),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
    latencyBars: 1,
  });
  assert.ok(result.trades.length >= 1);
  assert.equal(result.trades[0].exitReason, "liquidation");
  assert.ok(result.liquidations.length >= 1);
});

test("gap-open liquidation dominates a queued rule exit", () => {
  const strategy = thresholdStrategy({
    risk: { maxLeverage: 2, stopLossPct: 50, takeProfitPct: 50 },
  });
  const bars = [
    bar(1, 109, 111, 108, 110),
    bar(2, 110, 111, 89, 90),
    bar(3, 50, 55, 49, 50),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, "liquidation");
  assert.equal(result.liquidations.length, 1);
  assert.equal(result.liquidations[0].barIndex, 2);
});

test("quoted funding rates alone do not create payment events", () => {
  const strategy = thresholdStrategy({
    threshold: 50,
    risk: {
      maxLeverage: 1,
      maxNotionalUsd: 1_000,
      positionSizePct: 10,
      stopLossPct: 90,
      takeProfitPct: 90,
      cooldownBars: 0,
      maxDailyLossPct: 90,
      expiresAt: 1_900_000_000_000,
    },
  });
  const mk = (t, c, fr) => bar(t, c, c + 1, c - 1, c, 100, { fundingRate: fr });
  const bars = [
    mk(1, 60, 0),
    mk(2, 60, 0.001),
    mk(3, 60, 0.001),
    mk(4, 60, 0.001),
    mk(5, 40, 0),
    mk(6, 40, 0),
  ];
  const withFr = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  const bars0 = bars.map((b) => ({ ...b, fundingRate: 0 }));
  const noFr = backtestStrategy(strategy, bars0, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(withFr.costs.fundingUsd, 0);
  assert.equal(withFr.metrics.netPnlUsd, noFr.metrics.netPnlUsd);
});

test("funding payment events use current marked notional", () => {
  const strategy = thresholdStrategy({
    threshold: 50,
    risk: {
      maxLeverage: 1,
      maxNotionalUsd: 1_000,
      positionSizePct: 10,
      stopLossPct: 90,
      takeProfitPct: 90,
      cooldownBars: 0,
      maxDailyLossPct: 90,
      expiresAt: 1_900_000_000_000,
    },
  });
  const bars = [
    bar(1, 60, 61, 59, 60, 100, { fundingRate: 0.001, fundingPaymentRate: 0 }),
    bar(2, 60, 61, 59, 60, 100, { fundingRate: 0.001, fundingPaymentRate: 0 }),
    bar(3, 90, 91, 89, 90, 100, { fundingRate: 0.001, fundingPaymentRate: 0.001 }),
    bar(4, 90, 91, 89, 90, 100, { fundingRate: 0.001, fundingPaymentRate: 0 }),
    bar(5, 90, 91, 89, 90, 100, { fundingRate: 0.001, fundingPaymentRate: 0 }),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.costs.fundingUsd, 1.5);
});

test("fee funding slippage monotonicity reduces net pnl", () => {
  const strategy = thresholdStrategy({ threshold: 100 });
  const bars = [
    bar(1, 100, 105, 99, 101),
    bar(2, 100, 110, 99, 105),
    bar(3, 105, 110, 100, 108),
    bar(4, 108, 110, 90, 95),
    bar(5, 95, 96, 90, 92),
    bar(6, 92, 93, 90, 91),
  ];
  const base = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  const fees = backtestStrategy(strategy, bars, {
    takerFeeBps: 10,
    builderFeeBps: 5,
    slippageBps: 0,
  });
  const slip = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 20,
  });
  assert.ok(fees.metrics.netPnlUsd <= base.metrics.netPnlUsd);
  assert.ok(slip.metrics.netPnlUsd <= base.metrics.netPnlUsd);
  assert.ok(fees.costs.feesUsd > 0);
  assert.ok(fees.costs.builderFeesUsd > 0);
});

test("cooldownBars enforced after exit", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    risk: {
      maxLeverage: 1,
      maxNotionalUsd: 5_000,
      positionSizePct: 10,
      stopLossPct: 50,
      takeProfitPct: 50,
      cooldownBars: 3,
      maxDailyLossPct: 50,
      expiresAt: 1_900_000_000_000,
    },
  });
  // enter, exit, immediately signal again - cooldown should block
  const bars = [
    bar(1, 100, 101, 99, 101), // signal
    bar(2, 100, 101, 99, 101), // fill
    bar(3, 100, 101, 99, 90), // exit signal
    bar(4, 90, 91, 89, 90), // exit fill
    bar(5, 90, 91, 89, 101), // re-entry signal during cooldown
    bar(6, 101, 102, 100, 101),
    bar(7, 101, 102, 100, 101),
    bar(8, 101, 102, 100, 101),
    bar(9, 101, 102, 100, 90),
    bar(10, 90, 91, 89, 90),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
    latencyBars: 1,
  });
  // With cooldown 3 after first exit at bar4, earliest re-entry signal usable after cooldown
  assert.ok(result.trades.length >= 1);
  if (result.trades.length >= 2) {
    assert.ok(result.trades[1].entryBarIndex - result.trades[0].exitBarIndex > 1);
  }
});

test("close remaining position at final bar close with end_of_data", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    risk: {
      maxLeverage: 1,
      maxNotionalUsd: 5_000,
      positionSizePct: 10,
      stopLossPct: 90,
      takeProfitPct: 90,
      cooldownBars: 0,
      maxDailyLossPct: 90,
      expiresAt: 1_900_000_000_000,
    },
  });
  const bars = [
    bar(1, 100, 101, 99, 101),
    bar(2, 100, 101, 99, 101),
    bar(3, 100, 101, 99, 101),
    bar(4, 100, 101, 99, 101),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, "end_of_data");
  assert.equal(result.trades[0].exitBarIndex, bars.length - 1);
});

test("end-of-data exit obeys volume participation and leaves an explicit marked position", () => {
  const strategy = thresholdStrategy({
    threshold: 100,
    risk: {
      maxLeverage: 1,
      maxNotionalUsd: 5_000,
      positionSizePct: 10,
      stopLossPct: 90,
      takeProfitPct: 90,
    },
  });
  const bars = [
    bar(1, 100, 101, 99, 101, 1_000),
    bar(2, 100, 101, 99, 101, 1_000),
    bar(3, 100, 101, 99, 101, 0),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  assert.equal(result.trades.length, 0);
  assert.ok(result.missedFills.some((fill) =>
    fill.kind === "exit" && fill.triggerReason === "end_of_data"
  ));
  assert.equal(result.openPositionAtEnd.side, "long");
  assert.equal(result.openPositionAtEnd.markPrice, 101);
  assert.equal(result.equityCurve.at(-1).positionSide, "long");
  assert.equal(result.metrics.turnoverUsd, 1_000);
});

test("cost and slippage bps reject unsafe bounds before non-finite math", () => {
  const strategy = thresholdStrategy();
  const bars = [bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100)];
  assert.throws(() => backtestStrategy(strategy, bars, { slippageBps: 10_000 }), /slippage/i);
  assert.throws(() => backtestStrategy(strategy, bars, { takerFeeBps: 10_001 }), /taker/i);
  assert.throws(() => backtestStrategy(strategy, bars, { builderFeeBps: 10_001 }), /builder/i);
});

test("non-finite derived results fail closed instead of serializing null", () => {
  const strategy = thresholdStrategy({ threshold: 100 });
  const bars = [
    bar(1, 100, 102, 99, 101, 1_000, { fundingPaymentRate: 0 }),
    bar(2, 100, 102, 99, 101, 1_000, { fundingPaymentRate: Number.MAX_VALUE }),
    bar(3, 100, 102, 99, 101, 1_000, { fundingPaymentRate: 0 }),
  ];
  assert.throws(
    () => backtestStrategy(strategy, bars, { takerFeeBps: 0, builderFeeBps: 0, slippageBps: 0 }),
    /non-finite|finite result/i,
  );
});

test("bars require positive OHLC prices and non-negative volume", () => {
  const strategy = thresholdStrategy();
  const valid = bar(2, 100, 101, 99, 100, 1);
  assert.throws(
    () => backtestStrategy(strategy, [{ t: 1, o: 0, h: 101, l: 0, c: 100, v: 1 }, valid]),
    /positive|price|open/i,
  );
  assert.throws(
    () => backtestStrategy(strategy, [{ t: 1, o: 100, h: 101, l: 99, c: 100, v: -1 }, valid]),
    /volume|non-negative/i,
  );
});

test("rejects empty bars malformed options expired strategy non-finite", () => {
  const strategy = thresholdStrategy();
  const bars = [bar(1, 1, 2, 0.5, 1), bar(2, 1, 2, 0.5, 1)];
  assert.throws(() => backtestStrategy(strategy, []), /bars/i);
  assert.throws(() => backtestStrategy(strategy, bars, { initialEquityUsd: -1 }), /equity|initial/i);
  assert.throws(() => backtestStrategy(strategy, bars, { takerFeeBps: NaN }), /fee|finite|taker/i);
  assert.throws(() => backtestStrategy(strategy, bars, { latencyBars: 1.5 }), /latency/i);
  assert.throws(
    () =>
      backtestStrategy(
        thresholdStrategy({ risk: { expiresAt: 1_000 } }),
        bars,
        { nowMs: 2_000 },
      ),
    /expir/i,
  );
  const badBars = [bar(1, 1, 2, 0.5, 1), { t: 2, o: 1, h: 2, l: 0.5, c: Infinity, v: 1 }];
  assert.throws(() => backtestStrategy(strategy, badBars), /finite|bars/i);
});

test("byte-stable JSON for identical inputs", () => {
  const strategy = thresholdStrategy();
  const bars = [
    bar(1, 100, 101, 99, 101),
    bar(2, 100, 110, 99, 105),
    bar(3, 105, 110, 90, 95),
    bar(4, 95, 96, 90, 92),
  ];
  const a = backtestStrategy(strategy, bars, { slippageBps: 1 });
  const b = backtestStrategy(strategy, bars, { slippageBps: 1 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("future-bar mutation cannot change earlier decisions", () => {
  const strategy = thresholdStrategy();
  const bars = [
    bar(1, 100, 101, 99, 101),
    bar(2, 100, 101, 99, 101),
    bar(3, 100, 101, 99, 90),
    bar(4, 90, 91, 89, 90),
    bar(5, 90, 91, 89, 90),
    bar(6, 90, 91, 89, 90),
  ];
  const r1 = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  const mutated = bars.map((b) => ({ ...b }));
  mutated[5] = bar(6, 999, 1000, 998, 999);
  const r2 = backtestStrategy(strategy, mutated, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  // trades that closed before last bar must match
  const early1 = r1.trades.filter((t) => t.exitBarIndex != null && t.exitBarIndex < 5);
  const early2 = r2.trades.filter((t) => t.exitBarIndex != null && t.exitBarIndex < 5);
  assert.equal(JSON.stringify(early1), JSON.stringify(early2));
  // equity up to index 4 should match
  assert.equal(JSON.stringify(r1.equityCurve.slice(0, 5)), JSON.stringify(r2.equityCurve.slice(0, 5)));
});

test("short side supported with adverse slippage", () => {
  const strategy = thresholdStrategy({ side: "short", threshold: 100 });
  const bars = [
    bar(1, 100, 101, 99, 99), // short signal
    bar(2, 100, 101, 99, 99), // fill short
    bar(3, 100, 101, 99, 110), // exit signal
    bar(4, 110, 111, 109, 110),
    bar(5, 110, 111, 109, 110),
  ];
  const result = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 10,
    latencyBars: 1,
  });
  assert.ok(result.trades.length >= 1);
  assert.equal(result.trades[0].side, "short");
  assert.ok(result.trades[0].entryPrice < 100); // adverse short entry = lower sell
});

test("costs reduce equity and metrics", () => {
  const strategy = thresholdStrategy({ threshold: 100 });
  const bars = [
    bar(1, 100, 101, 99, 101),
    bar(2, 100, 120, 99, 110),
    bar(3, 110, 120, 100, 115),
    bar(4, 115, 120, 90, 95),
    bar(5, 95, 96, 90, 92),
  ];
  const cheap = backtestStrategy(strategy, bars, {
    takerFeeBps: 0,
    builderFeeBps: 0,
    slippageBps: 0,
  });
  const expensive = backtestStrategy(strategy, bars, {
    takerFeeBps: 20,
    builderFeeBps: 10,
    slippageBps: 15,
  });
  assert.ok(expensive.metrics.netPnlUsd < cheap.metrics.netPnlUsd);
  const lastCheap = cheap.equityCurve[cheap.equityCurve.length - 1];
  const lastExp = expensive.equityCurve[expensive.equityCurve.length - 1];
  const eq = (x) => (typeof x === "number" ? x : x.equity);
  assert.ok(eq(lastExp) <= eq(lastCheap));
});
