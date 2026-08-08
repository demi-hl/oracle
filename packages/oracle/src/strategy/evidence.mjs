// Deterministic strategy evidence gate. Chronological train/holdout + walk-forward.
// No network, keys, clock, I/O, or randomness. Optimizer output alone is never evidence.

import { createHash } from "node:crypto";
import { STRATEGY_COMPILER_HASH } from "./compiler.mjs";
import { normalizeStrategy, strategyHash } from "./schema.mjs";
import { backtestStrategy, strategyBarsHash } from "./backtest.mjs";

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
    exposurePct: bt.metrics.exposurePct,
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

function evidenceFacts(evidence) {
  if (!isPlainObject(evidence)) throw new TypeError("evidence artifact must be a plain object");
  if (!EVIDENCE_STATUSES.includes(evidence.status)) {
    throw new TypeError("evidence artifact status is invalid");
  }
  for (const key of ["strategyHash", "compilerHash", "barsHash"]) {
    if (typeof evidence[key] !== "string" || !/^[0-9a-f]{64}$/.test(evidence[key])) {
      throw new TypeError(`evidence artifact ${key} must be a sha256 hash`);
    }
  }
  if (!isPlainObject(evidence.split)) throw new TypeError("evidence artifact split required");
  if (!Array.isArray(evidence.flags)) throw new TypeError("evidence artifact flags must be an array");
  if (!isPlainObject(evidence.walkForward) || !Array.isArray(evidence.walkForward.windows)) {
    throw new TypeError("evidence artifact walkForward windows required");
  }
  if (
    evidence.status === "pass_live_eligible" &&
    (!isPlainObject(evidence.train) || !isPlainObject(evidence.holdout))
  ) {
    throw new TypeError("live-eligible evidence artifact requires train and holdout facts");
  }
  return sortKeysDeep({
    barsHash: evidence.barsHash,
    compilerHash: evidence.compilerHash,
    flags: evidence.flags.map((flag) => sortKeysDeep(flag)),
    holdout: evidence.holdout ?? null,
    split: evidence.split,
    status: evidence.status,
    strategyHash: evidence.strategyHash,
    train: evidence.train ?? null,
    walkForward: {
      passRate: evidence.walkForward.passRate,
      windowsRun:
        evidence.walkForward.windowsRun ?? evidence.walkForward.windows.length,
      windows: evidence.walkForward.windows.map((window) => ({
        index: window.index,
        trainStartIndex: window.trainStartIndex,
        trainEndIndex: window.trainEndIndex,
        passed: window.passed,
        reason: window.reason,
        evalStartIndex: window.evalStartIndex,
        evalEndIndex: window.evalEndIndex,
        metrics: window.metrics,
      })),
    },
  });
}

export function computeEvidenceArtifactId(evidence) {
  return createHash("sha256")
    .update(JSON.stringify(evidenceFacts(evidence)), "utf8")
    .digest("hex");
}

function integer(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function metricFacts(section, label) {
  if (!isPlainObject(section) || !isPlainObject(section.metrics)) {
    throw new Error(`${label} metrics required`);
  }
  const tradeCount = integer(section.tradeCount, `${label}.tradeCount`);
  if (section.metrics.tradeCount !== tradeCount) {
    throw new Error(`${label} tradeCount contradicts metrics.tradeCount`);
  }
  for (const key of ["netPnlUsd", "profitFactor", "maxDrawdownPct"]) {
    if (!isFiniteNumber(section.metrics[key])) {
      throw new Error(`${label}.metrics.${key} must be finite`);
    }
  }
  if (section.metrics.maxDrawdownPct < 0) {
    throw new Error(`${label}.metrics.maxDrawdownPct must be >= 0`);
  }
  return section.metrics;
}

function assertLiveEligibleConsistency(evidence, { maxDailyLossPct } = {}) {
  const split = evidence.split;
  const trainStart = integer(split.trainStartIndex, "split.trainStartIndex");
  const trainEnd = integer(split.trainEndIndex, "split.trainEndIndex");
  const trainCount = integer(split.trainBarCount, "split.trainBarCount", 1);
  const holdoutStart = integer(split.holdoutStartIndex, "split.holdoutStartIndex");
  const holdoutEnd = integer(split.holdoutEndIndex, "split.holdoutEndIndex");
  const holdoutCount = integer(split.holdoutBarCount, "split.holdoutBarCount", 1);
  if (
    trainStart !== 0 ||
    trainEnd - trainStart + 1 !== trainCount ||
    holdoutStart !== trainEnd + 1 ||
    holdoutEnd - holdoutStart + 1 !== holdoutCount
  ) {
    throw new Error("evidence split must be contiguous, chronological, and count-consistent");
  }
  if (!isFiniteNumber(split.trainFraction) || split.trainFraction <= 0 || split.trainFraction >= 1) {
    throw new Error("split.trainFraction must be in (0,1)");
  }

  metricFacts(evidence.train, "train");
  const holdoutMetrics = metricFacts(evidence.holdout, "holdout");
  if (
    holdoutMetrics.tradeCount < 1 ||
    holdoutMetrics.netPnlUsd <= 0 ||
    holdoutMetrics.profitFactor <= 1
  ) {
    throw new Error("live-eligible holdout metrics do not pass");
  }
  if (isFiniteNumber(maxDailyLossPct) && holdoutMetrics.maxDrawdownPct > maxDailyLossPct) {
    throw new Error("live-eligible holdout drawdown exceeds strategy risk");
  }
  if (evidence.flags.length > 0) {
    throw new Error("live-eligible evidence cannot contain failure flags");
  }

  const walkForward = evidence.walkForward;
  const windows = walkForward.windows;
  if (windows.length < 1 || walkForward.windowsRun !== windows.length) {
    throw new Error("live-eligible walk-forward windowsRun must match nonempty windows");
  }
  let passed = 0;
  let priorEvalEnd = -1;
  for (let index = 0; index < windows.length; index++) {
    const window = windows[index];
    if (!isPlainObject(window) || window.index !== index || typeof window.passed !== "boolean") {
      throw new Error("walk-forward windows must be ordered and structurally valid");
    }
    const windowTrainStart = integer(window.trainStartIndex, `walkForward.windows[${index}].trainStartIndex`);
    const windowTrainEnd = integer(window.trainEndIndex, `walkForward.windows[${index}].trainEndIndex`);
    const evalStart = integer(window.evalStartIndex, `walkForward.windows[${index}].evalStartIndex`);
    const evalEnd = integer(window.evalEndIndex, `walkForward.windows[${index}].evalEndIndex`);
    if (
      windowTrainStart !== 0 ||
      windowTrainEnd >= evalStart ||
      evalStart > evalEnd ||
      evalStart <= priorEvalEnd
    ) {
      throw new Error("walk-forward windows must be chronological and disjoint");
    }
    priorEvalEnd = evalEnd;
    if (window.passed) {
      passed += 1;
      if (window.reason !== "pass") throw new Error("passed walk-forward window reason must be pass");
      const metrics = metricFacts({ metrics: window.metrics, tradeCount: window.metrics?.tradeCount }, `walkForward.windows[${index}]`);
      if (metrics.tradeCount < 1 || metrics.netPnlUsd <= 0 || metrics.profitFactor <= 1) {
        throw new Error("passed walk-forward window metrics do not pass");
      }
      if (isFiniteNumber(maxDailyLossPct) && metrics.maxDrawdownPct > maxDailyLossPct) {
        throw new Error("passed walk-forward drawdown exceeds strategy risk");
      }
    } else if (window.reason === "pass") {
      throw new Error("failed walk-forward window cannot have pass reason");
    }
  }
  const passRate = passed / windows.length;
  if (
    !isFiniteNumber(walkForward.passRate) ||
    Math.abs(walkForward.passRate - passRate) > Number.EPSILON ||
    passRate < 0.6
  ) {
    throw new Error("walk-forward passRate contradicts concrete windows or is below live threshold");
  }
}

export function assertEvidenceArtifact(evidence, options = {}) {
  if (typeof evidence?.id !== "string" || !/^[0-9a-f]{64}$/.test(evidence.id)) {
    throw new Error("evidence.id must be a sha256 evidence artifact hash");
  }
  const facts = evidenceFacts(evidence);
  const canonical = sortKeysDeep({ id: evidence.id, ...facts });
  if (JSON.stringify(sortKeysDeep(evidence)) !== JSON.stringify(canonical)) {
    throw new Error("evidence artifact contains fields unbound from its deterministic identity");
  }
  const expected = computeEvidenceArtifactId(evidence);
  if (evidence.id !== expected) {
    throw new Error("evidence.id does not match its deterministic artifact facts digest");
  }
  if (evidence.status === "pass_live_eligible") {
    assertLiveEligibleConsistency(evidence, options);
  }
  return evidence;
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
  const barsHash = strategyBarsHash(bars);
  const n = bars.length;

  const fail = (extraFlags = [], partial = {}) => {
    const body = buildResult({
      status: "fail",
      strategy,
      sHash,
      barsHash,
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
    barsHash,
    split,
    train,
    holdout,
    walkForward,
    flags,
  });
}

function buildResult({ status, strategy, sHash, barsHash, split, train, holdout, walkForward, flags }) {
  const result = {
    status,
    strategyHash: sHash,
    compilerHash: STRATEGY_COMPILER_HASH,
    barsHash,
    split,
    train,
    holdout,
    walkForward,
    flags,
  };
  result.id = computeEvidenceArtifactId(result);

  return deepFreeze(sortKeysDeep(JSON.parse(JSON.stringify(result))));
}
