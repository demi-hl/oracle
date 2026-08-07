// Deterministic strategy evidence gate. Chronological train/holdout + walk-forward.
// No network, keys, clock, I/O, or randomness. Optimizer output alone is never evidence.

import { createHash } from "node:crypto";
import { STRATEGY_COMPILER_HASH } from "./compiler.mjs";
import { normalizeStrategy, strategyHash } from "./schema.mjs";
import { backtestStrategy } from "./backtest.mjs";

export const EVIDENCE_STATUSES = Object.freeze([
  "fail",
  "pass_paper_only",
  "pass_live_eligible",
]);

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function deepFreeze(value) {
  if (value == null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value != null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

function metricsSlice(bt) {
  return {
    netPnlUsd: bt.metrics.netPnlUsd,
    netPnlPct: bt.metrics.netPnlPct,
    maxDrawdownPct: bt.metrics.maxDrawdownPct,
    winRate: bt.metrics.winRate,
    profitFactor: bt.metrics.profitFactor,
    tradeCount: bt.metrics.tradeCount,
    sharpe: bt.metrics.sharpe,
    turnoverUsd: bt.metrics.turnoverUsd,
  };
}

function costsSlice(bt) {
  return {
    feesUsd: bt.costs.feesUsd,
    builderFeesUsd: bt.costs.builderFeesUsd,
    fundingUsd: bt.costs.fundingUsd,
    slippageUsd: bt.costs.slippageUsd,
  };
}

function totalCosts(costs) {
  return (
    (costs.feesUsd || 0) +
    (costs.builderFeesUsd || 0) +
    Math.max(0, costs.fundingUsd || 0) +
    (costs.slippageUsd || 0)
  );
}

function grossGainsFromTrades(bt) {
  let g = 0;
  for (const t of bt.trades) {
    if (t.grossPnlUsd > 0) g += t.grossPnlUsd;
  }
  return g;
}

function windowPass(metrics, risk, minTrades) {
  if (!metrics || metrics.tradeCount < Math.max(1, Math.min(minTrades, 3))) return false;
  if (!(metrics.netPnlUsd > 0)) return false;
  if (!(metrics.profitFactor > 1)) return false;
  if (!(metrics.maxDrawdownPct <= risk.maxDailyLossPct)) return false;
  return true;
}

/**
 * Evaluate strategy evidence on chronological bars.
 * Train and holdout are disjoint; holdout starts strictly after train.
 */
export function evaluateEvidence({
  strategy: strategyInput,
  bars,
  backtestOptions = {},
  trainFraction = 0.7,
  walkForwardWindows = 3,
  minTrades = 10,
} = {}) {
  const flags = [];
  if (!isPlainObject(strategyInput)) {
    throw new TypeError("strategy must be a plain object");
  }
  if (!Array.isArray(bars)) {
    throw new TypeError("bars must be an array");
  }
  if (!isPlainObject(backtestOptions)) {
    throw new TypeError("backtestOptions must be a plain object");
  }
  if (!isFiniteNumber(trainFraction) || trainFraction <= 0 || trainFraction >= 1) {
    throw new TypeError("trainFraction must be in (0,1)");
  }
  if (!Number.isInteger(walkForwardWindows) || walkForwardWindows < 1) {
    throw new TypeError("walkForwardWindows must be a positive integer");
  }
  if (!Number.isInteger(minTrades) || minTrades < 0) {
    throw new TypeError("minTrades must be an integer >= 0");
  }

  const strategy = normalizeStrategy(strategyInput);
  const sHash = strategyHash(strategy);
  const n = bars.length;

  const fail = (extraFlags = [], partial = {}) => {
    const body = buildResult({
      status: "fail",
      strategy,
      sHash,
      split: partial.split || {
        trainStartIndex: 0,
        trainEndIndex: -1,
        trainBarCount: 0,
        holdoutStartIndex: 0,
        holdoutEndIndex: -1,
        holdoutBarCount: 0,
        trainFraction,
      },
      train: partial.train || null,
      holdout: partial.holdout || null,
      walkForward: partial.walkForward || { windows: [], passRate: 0 },
      flags: [...flags, ...extraFlags],
    });
    return body;
  };

  if (n < 10) {
    return fail([{ type: "insufficient_bars", message: "need at least 10 bars for evidence" }]);
  }

  const trainCount = Math.floor(n * trainFraction);
  const holdoutStart = trainCount;
  const holdoutCount = n - holdoutStart;

  if (trainCount < 5 || holdoutCount < 3) {
    return fail([
      {
        type: "invalid_windowing",
        message: "train/holdout split too small",
        trainCount,
        holdoutCount,
      },
    ]);
  }

  const trainBars = bars.slice(0, trainCount);
  const holdoutBars = bars.slice(holdoutStart);

  // Independent backtests; no train state into holdout
  let trainBt;
  let holdoutBt;
  try {
    trainBt = backtestStrategy(strategy, trainBars, backtestOptions);
    holdoutBt = backtestStrategy(strategy, holdoutBars, backtestOptions);
  } catch (err) {
    return fail([{ type: "backtest_error", message: String(err.message || err) }]);
  }

  const train = {
    metrics: metricsSlice(trainBt),
    costs: costsSlice(trainBt),
    tradeCount: trainBt.metrics.tradeCount,
  };
  const holdout = {
    metrics: metricsSlice(holdoutBt),
    costs: costsSlice(holdoutBt),
    tradeCount: holdoutBt.metrics.tradeCount,
  };

  const split = {
    trainStartIndex: 0,
    trainEndIndex: trainCount - 1,
    trainBarCount: trainCount,
    holdoutStartIndex: holdoutStart,
    holdoutEndIndex: n - 1,
    holdoutBarCount: holdoutCount,
    trainFraction,
  };

  // Walk-forward: chronological disjoint evaluation windows over full series
  const wfWindows = [];
  const wfSize = Math.floor(n / (walkForwardWindows + 1));
  if (wfSize < 3) {
    flags.push({
      type: "invalid_windowing",
      message: "walk-forward window size too small",
      wfSize,
    });
  } else {
    for (let w = 0; w < walkForwardWindows; w++) {
      // train prefix grows; eval window is next wfSize bars after train prefix
      const trainEnd = wfSize * (w + 1);
      const evalStart = trainEnd;
      const evalEnd = Math.min(n, evalStart + wfSize);
      if (evalEnd - evalStart < 3 || trainEnd < 3) {
        wfWindows.push({
          index: w,
          trainStartIndex: 0,
          trainEndIndex: trainEnd - 1,
          evalStartIndex: evalStart,
          evalEndIndex: evalEnd - 1,
          passed: false,
          reason: "window_too_small",
          metrics: null,
        });
        continue;
      }
      const evalBars = bars.slice(evalStart, evalEnd);
      let evalBt;
      try {
        evalBt = backtestStrategy(strategy, evalBars, backtestOptions);
      } catch (err) {
        wfWindows.push({
          index: w,
          trainStartIndex: 0,
          trainEndIndex: trainEnd - 1,
          evalStartIndex: evalStart,
          evalEndIndex: evalEnd - 1,
          passed: false,
          reason: "backtest_error",
          metrics: null,
        });
        continue;
      }
      const m = metricsSlice(evalBt);
      const passed = windowPass(m, strategy.risk, minTrades);
      wfWindows.push({
        index: w,
        trainStartIndex: 0,
        trainEndIndex: trainEnd - 1,
        evalStartIndex: evalStart,
        evalEndIndex: evalEnd - 1,
        passed,
        reason: passed ? "pass" : "fail_metrics",
        metrics: m,
      });
    }
  }

  const wfPassed = wfWindows.filter((w) => w.passed).length;
  const passRate = wfWindows.length === 0 ? 0 : wfPassed / wfWindows.length;
  const walkForward = { windows: wfWindows, passRate, windowsRun: wfWindows.length };

  // Evidence gates
  if (holdout.metrics.tradeCount === 0 && train.metrics.tradeCount === 0) {
    flags.push({ type: "no_trades", message: "no trades in train or holdout" });
  }
  if (holdout.metrics.tradeCount === 0) {
    flags.push({ type: "absent_oos_trades", message: "holdout produced no trades" });
  }
  if (holdout.metrics.netPnlUsd < 0) {
    flags.push({ type: "holdout_loss", message: "holdout netPnlUsd is negative" });
  }
  // severe OOS collapse: train strong, holdout much worse
  if (
    train.metrics.netPnlUsd > 0 &&
    holdout.metrics.netPnlUsd < 0 &&
    train.metrics.netPnlUsd > Math.abs(holdout.metrics.netPnlUsd) * 0.25
  ) {
    flags.push({
      type: "overfit",
      message: "profitable train with losing holdout (OOS collapse)",
    });
  } else if (
    train.metrics.netPnlUsd > 0 &&
    holdout.metrics.netPnlUsd > 0 &&
    holdout.metrics.netPnlUsd < train.metrics.netPnlUsd * 0.1 &&
    train.metrics.tradeCount >= minTrades
  ) {
    flags.push({
      type: "severe_oos_collapse",
      message: "holdout pnl collapsed vs train",
    });
  }

  const holdoutCosts = totalCosts(holdout.costs);
  const holdoutGross = grossGainsFromTrades(holdoutBt);
  if (holdoutGross > 0 && holdoutCosts > holdoutGross) {
    flags.push({
      type: "costs_exceed_gross",
      message: "holdout costs exceed gross gains",
    });
  }

  const hasFailFlag = flags.some((f) =>
    [
      "insufficient_bars",
      "invalid_windowing",
      "absent_oos_trades",
      "holdout_loss",
      "no_trades",
      "severe_oos_collapse",
      "backtest_error",
    ].includes(f.type),
  );

  const overfit = flags.some((f) => f.type === "overfit");

  let status = "fail";

  const liveOk =
    holdout.metrics.tradeCount >= minTrades &&
    holdout.metrics.netPnlUsd > 0 &&
    holdout.metrics.profitFactor > 1 &&
    holdout.metrics.maxDrawdownPct <= strategy.risk.maxDailyLossPct &&
    passRate >= 0.6 &&
    !(holdoutGross > 0 && holdoutCosts > holdoutGross) &&
    !overfit &&
    !flags.some((f) => f.type === "severe_oos_collapse" || f.type === "invalid_windowing");

  if (liveOk) {
    status = "pass_live_eligible";
  } else if (
    !hasFailFlag &&
    holdout.metrics.tradeCount > 0 &&
    train.metrics.tradeCount > 0 &&
    Number.isFinite(holdout.metrics.netPnlUsd)
  ) {
    // valid but weak/undersampled
    status = "pass_paper_only";
    if (holdout.metrics.tradeCount < minTrades) {
      flags.push({
        type: "undersampled",
        message: "holdout trades below minTrades",
      });
    }
  } else if (
    overfit &&
    holdout.metrics.tradeCount > 0 &&
    train.metrics.netPnlUsd > 0
  ) {
    // profitable IS losing OOS: fail or paper only with overfit flag
    status = "fail";
  } else if (holdout.metrics.tradeCount > 0 && train.metrics.tradeCount > 0 && !hasFailFlag) {
    status = "pass_paper_only";
  } else {
    status = "fail";
  }

  // If holdout loss, never live; prefer fail
  if (holdout.metrics.netPnlUsd < 0) {
    status = status === "pass_live_eligible" ? "fail" : status === "pass_paper_only" ? "pass_paper_only" : "fail";
    // Spec: fail if holdout loss OR paper only with overfit. Prefer fail when loss.
    status = "fail";
  }

  return buildResult({
    status,
    strategy,
    sHash,
    split,
    train,
    holdout,
    walkForward,
    flags,
  });
}

function buildResult({ status, strategy, sHash, split, train, holdout, walkForward, flags }) {
  const facts = sortKeysDeep({
    compilerHash: STRATEGY_COMPILER_HASH,
    flags: flags.map((f) => sortKeysDeep(f)),
    holdout,
    split,
    status,
    strategyHash: sHash,
    train,
    walkForward: {
      passRate: walkForward.passRate,
      windowsRun: walkForward.windowsRun ?? (walkForward.windows ? walkForward.windows.length : 0),
      windows: (walkForward.windows || []).map((w) => ({
        index: w.index,
        passed: w.passed,
        reason: w.reason,
        evalStartIndex: w.evalStartIndex,
        evalEndIndex: w.evalEndIndex,
        metrics: w.metrics,
      })),
    },
  });

  const id = createHash("sha256").update(JSON.stringify(facts), "utf8").digest("hex");

  const result = {
    id,
    status,
    strategyHash: sHash,
    compilerHash: STRATEGY_COMPILER_HASH,
    split,
    train,
    holdout,
    walkForward,
    flags,
  };

  return deepFreeze(sortKeysDeep(JSON.parse(JSON.stringify(result))));
}
