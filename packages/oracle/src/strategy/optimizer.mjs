// Bounded deterministic strategy parameter optimizer. Train bars only. No I/O/network/clock.

import { createHash } from "node:crypto";
import {
  STRATEGY_COMPILER_HASH,
  compileStrategy,
} from "./compiler.mjs";
import {
  applyParameterOverrides,
  normalizeStrategy,
  strategyHash,
} from "./schema.mjs";
import { backtestStrategy, strategyBarsHash } from "./backtest.mjs";

export const MAX_OPTIMIZER_TRIALS = 256;

const OBJECTIVES = new Set(["netPnlUsd", "profitFactor", "sharpe", "maxDrawdownPct"]);

function isForbiddenOptionKey(key) {
  const k = String(key).toLowerCase();
  // Reject keys that name holdout/test/oos data. Do not match substrings inside
  // legitimate keys like backtestOptions.
  if (k === "holdout" || k === "test" || k === "oos") return true;
  if (k.includes("holdout")) return true;
  if (k.includes("oos")) return true;
  // bare or compound test bars keys, but not "backtest*"
  if (k === "testbars" || k.endsWith("testbars") || k.startsWith("test") || k.endsWith("test")) {
    if (k.includes("backtest")) return false;
    return true;
  }
  return false;
}

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

function canonicalParamsJson(params) {
  return JSON.stringify(sortKeysDeep(params));
}

function gridValues(param) {
  const { min, max, step } = param;
  if (!(step > 0) || min > max) return [];
  const values = [];
  // integer-safe iteration
  const n = Math.floor((max - min) / step + 1e-9);
  for (let i = 0; i <= n; i++) {
    const v = min + i * step;
    if (v > max + 1e-9) break;
    // snap to avoid float drift
    const snapped = Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : Number(v.toPrecision(12));
    if (snapped < min - 1e-9 || snapped > max + 1e-9) continue;
    values.push(snapped);
  }
  // ensure max included if on grid
  if (values.length === 0) return [];
  const last = values[values.length - 1];
  if (Math.abs(last - max) > 1e-9) {
    const n2 = (max - min) / step;
    if (Math.abs(n2 - Math.round(n2)) <= 1e-9) values.push(max);
  }
  return values;
}

function cartesian(paramNames, grids) {
  if (paramNames.length === 0) return [];
  let combos = [{}];
  for (const name of paramNames) {
    const vals = grids[name];
    const next = [];
    for (const base of combos) {
      for (const v of vals) {
        next.push({ ...base, [name]: v });
      }
    }
    combos = next;
  }
  // stable order by canonical JSON
  combos.sort((a, b) => {
    const ja = canonicalParamsJson(a);
    const jb = canonicalParamsJson(b);
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  });
  return combos;
}

function better(objective, aMetrics, aParams, bMetrics, bParams) {
  // return true if a is better than b
  let cmp = 0;
  if (objective === "maxDrawdownPct") {
    // lower is better
    cmp = aMetrics.maxDrawdownPct - bMetrics.maxDrawdownPct;
    if (cmp !== 0) return cmp < 0;
  } else {
    cmp = aMetrics[objective] - bMetrics[objective];
    if (cmp !== 0) return cmp > 0;
  }
  // tie-break canonical params ascending
  const ja = canonicalParamsJson(aParams);
  const jb = canonicalParamsJson(bParams);
  return ja < jb;
}

/**
 * Bounded deterministic grid search over strategy.parameters only.
 * Never accepts holdout/test/oos bars.
 */
export function optimizeStrategy(strategyInput, trainBars, options = {}) {
  if (!isPlainObject(options)) throw new TypeError("options must be a plain object");
  for (const key of Object.keys(options)) {
    if (isForbiddenOptionKey(key)) {
      throw new TypeError(`options must not include holdout/test/oos key "${key}"`);
    }
  }

  const allowed = new Set(["maxTrials", "objective", "backtestOptions"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`unknown option "${key}"`);
  }

  let maxTrials = 64;
  if ("maxTrials" in options) {
    const v = options.maxTrials;
    if (!Number.isInteger(v) || v < 1 || v > MAX_OPTIMIZER_TRIALS) {
      throw new TypeError(`maxTrials must be an integer 1..${MAX_OPTIMIZER_TRIALS}`);
    }
    maxTrials = v;
  }

  const objective = options.objective ?? "netPnlUsd";
  if (!OBJECTIVES.has(objective)) {
    throw new TypeError(
      `objective must be one of ${[...OBJECTIVES].join("|")}`,
    );
  }

  const backtestOptions = options.backtestOptions ?? {};
  if (!isPlainObject(backtestOptions)) {
    throw new TypeError("backtestOptions must be a plain object");
  }
  for (const key of Object.keys(backtestOptions)) {
    if (isForbiddenOptionKey(key)) {
      throw new TypeError(`backtestOptions must not include holdout/test/oos key "${key}"`);
    }
  }

  const base = normalizeStrategy(strategyInput);
  const paramNames = Object.keys(base.parameters).sort();
  if (paramNames.length === 0) {
    throw new Error("optimizeStrategy requires at least one declared parameter");
  }

  const grids = {};
  let total = 1;
  for (const name of paramNames) {
    const vals = gridValues(base.parameters[name]);
    if (vals.length === 0) {
      throw new Error(`parameter "${name}" produces an empty grid`);
    }
    grids[name] = vals;
    total *= vals.length;
  }

  const allCombos = cartesian(paramNames, grids);
  if (allCombos.length === 0) {
    throw new Error("parameter grid is empty");
  }

  const limited = allCombos.slice(0, maxTrials);
  const candidates = [];
  let best = null;
  let normalizedBacktestConfig = null;

  for (const parameters of limited) {
    const candidateStrategy = applyParameterOverrides(base, parameters);
    const bt = backtestStrategy(candidateStrategy, trainBars, backtestOptions);
    if (normalizedBacktestConfig == null) normalizedBacktestConfig = bt.config;
    const metrics = {
      netPnlUsd: bt.metrics.netPnlUsd,
      netPnlPct: bt.metrics.netPnlPct,
      maxDrawdownPct: bt.metrics.maxDrawdownPct,
      winRate: bt.metrics.winRate,
      profitFactor: bt.metrics.profitFactor,
      tradeCount: bt.metrics.tradeCount,
      sharpe: bt.metrics.sharpe,
      turnoverUsd: bt.metrics.turnoverUsd,
    };
    const entry = { parameters: { ...parameters }, metrics };
    candidates.push(entry);
    if (
      !best ||
      better(objective, metrics, parameters, best.metrics, best.parameters)
    ) {
      best = entry;
    }
  }

  // sort candidates: best first by objective then canonical params
  candidates.sort((a, b) => {
    if (better(objective, a.metrics, a.parameters, b.metrics, b.parameters)) return -1;
    if (better(objective, b.metrics, b.parameters, a.metrics, a.parameters)) return 1;
    return 0;
  });

  const bestParameters = { ...best.parameters };
  const bestStrategy = applyParameterOverrides(base, bestParameters);

  const core = {
    strategyHash: strategyHash(base),
    compilerHash: STRATEGY_COMPILER_HASH,
    trainBarsHash: strategyBarsHash(trainBars),
    backtestConfig: normalizedBacktestConfig,
    objective,
    maxTrials,
    trialsRun: candidates.length,
    candidates,
    bestParameters,
    bestStrategy,
  };
  const result = {
    id: createHash("sha256")
      .update(JSON.stringify(sortKeysDeep(core)), "utf8")
      .digest("hex"),
    ...core,
  };

  // touch compile once for hash consistency side-effect free
  void compileStrategy;
  return deepFreeze(sortKeysDeep(JSON.parse(JSON.stringify(result))));
}
