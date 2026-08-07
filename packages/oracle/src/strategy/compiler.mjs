// Deterministic strategy compiler. No network, keys, clock, or I/O.

import { createHash } from "node:crypto";
import {
  applyParameterOverrides,
  normalizeStrategy,
  strategyHash,
} from "./schema.mjs";
import { sma, ema, rsi, macd, bollinger, atr } from "./indicators.mjs";

export const STRATEGY_COMPILER_VERSION = 1;
export const STRATEGY_COMPILER_HASH = createHash("sha256")
  .update(JSON.stringify({
    version: STRATEGY_COMPILER_VERSION,
    nodeTypes: ["input", "constant", "indicator", "compare", "logic", "cross"],
    indicators: ["sma", "ema", "rsi", "macd", "bollinger", "atr"],
    rules: ["entryLong", "entryShort", "exitLong", "exitShort"],
  }))
  .digest("hex");

const FIELD_MAP = Object.freeze({
  open: "o",
  high: "h",
  low: "l",
  close: "c",
  volume: "v",
  fundingRate: "fundingRate",
  openInterest: "openInterest",
});

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function topoOrder(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depsOf = (n) => {
    switch (n.type) {
      case "indicator":
        return n.input ? [n.input] : [];
      case "compare":
      case "cross":
        return [n.left, n.right];
      case "logic":
        return [...n.inputs];
      default:
        return [];
    }
  };
  const indeg = new Map();
  const adj = new Map();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const n of nodes) {
    for (const d of depsOf(n)) {
      if (!byId.has(d)) continue;
      adj.get(d).push(n.id);
      indeg.set(n.id, indeg.get(n.id) + 1);
    }
  }
  const q = [];
  for (const [id, d] of indeg) if (d === 0) q.push(id);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const nxt of adj.get(id)) {
      indeg.set(nxt, indeg.get(nxt) - 1);
      if (indeg.get(nxt) === 0) q.push(nxt);
    }
  }
  if (order.length !== nodes.length) throw new Error("strategy graph is cyclic");
  return order;
}

function resolveNum(spec, params) {
  if (spec != null && typeof spec === "object" && "param" in spec) {
    return params[spec.param].value;
  }
  return spec;
}

function assertBars(bars, index) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new TypeError("bars must be a non-empty array");
  }
  if (!Number.isInteger(index) || index < 0 || index >= bars.length) {
    throw new RangeError("index out of range");
  }
  let prevT = null;
  for (let i = 0; i <= index; i++) {
    const b = bars[i];
    if (b == null || typeof b !== "object" || Array.isArray(b)) {
      throw new TypeError(`bars[${i}] must be an object`);
    }
    const { t, o, h, l, c, v } = b;
    if (!isFiniteNumber(t) && !(typeof t === "number" && Number.isFinite(t))) {
      // t must be finite number (epoch ms)
    }
    if (!Number.isFinite(t)) throw new TypeError(`bars[${i}].t must be finite`);
    for (const [k, val] of [
      ["o", o],
      ["h", h],
      ["l", l],
      ["c", c],
      ["v", v],
    ]) {
      if (!isFiniteNumber(val)) throw new TypeError(`bars[${i}].${k} must be a finite number`);
    }
    if (h < Math.max(o, c, l)) {
      throw new TypeError(`bars[${i}] high must be >= max(open, close, low)`);
    }
    if (l > Math.min(o, c, h)) {
      throw new TypeError(`bars[${i}] low must be <= min(open, close, high)`);
    }
    if (prevT != null && !(t > prevT)) {
      throw new TypeError("bars t must be strictly increasing");
    }
    prevT = t;
    if ("fundingRate" in b && b.fundingRate != null && !isFiniteNumber(b.fundingRate)) {
      throw new TypeError(`bars[${i}].fundingRate must be finite when present`);
    }
    if ("openInterest" in b && b.openInterest != null && !isFiniteNumber(b.openInterest)) {
      throw new TypeError(`bars[${i}].openInterest must be finite when present`);
    }
  }
}

function seriesFor(nodeId, nodesById, params, bars, upto, cache) {
  if (cache.has(nodeId)) return cache.get(nodeId);
  const node = nodesById.get(nodeId);
  let series;

  switch (node.type) {
    case "input": {
      const key = FIELD_MAP[node.field];
      series = new Array(upto + 1);
      for (let i = 0; i <= upto; i++) {
        const v = bars[i][key];
        series[i] = v === undefined ? null : v;
      }
      break;
    }
    case "constant": {
      const value = resolveNum(node.value, params);
      series = new Array(upto + 1).fill(value);
      break;
    }
    case "indicator": {
      const period = node.period != null ? resolveNum(node.period, params) : undefined;
      if (node.indicator === "atr") {
        const slice = [];
        for (let i = 0; i <= upto; i++) {
          const b = bars[i];
          slice.push({ o: b.o, h: b.h, l: b.l, c: b.c });
        }
        series = atr(slice, period);
        break;
      }
      const inputSeries = seriesFor(node.input, nodesById, params, bars, upto, cache);
      // Indicators require finite numeric inputs; nulls in optional fields reject.
      const numeric = inputSeries.map((v, i) => {
        if (v == null || !isFiniteNumber(v)) {
          throw new TypeError(`indicator input ${node.input} has non-finite value at ${i}`);
        }
        return v;
      });
      if (node.indicator === "sma") series = sma(numeric, period);
      else if (node.indicator === "ema") series = ema(numeric, period);
      else if (node.indicator === "rsi") series = rsi(numeric, period);
      else if (node.indicator === "macd") {
        const out = macd(numeric, {
          fastPeriod: resolveNum(node.fastPeriod, params),
          slowPeriod: resolveNum(node.slowPeriod, params),
          signalPeriod: resolveNum(node.signalPeriod, params),
        });
        series = out[node.output];
      } else if (node.indicator === "bollinger") {
        const out = bollinger(numeric, {
          period,
          stdDev: resolveNum(node.stdDev, params),
        });
        series = out[node.output];
      } else {
        throw new Error(`unsupported indicator ${node.indicator}`);
      }
      break;
    }
    case "compare": {
      const left = seriesFor(node.left, nodesById, params, bars, upto, cache);
      const right = seriesFor(node.right, nodesById, params, bars, upto, cache);
      series = new Array(upto + 1);
      for (let i = 0; i <= upto; i++) {
        const L = left[i];
        const R = right[i];
        if (L == null || R == null || !isFiniteNumber(L) || !isFiniteNumber(R)) {
          series[i] = false;
          continue;
        }
        switch (node.op) {
          case "gt":
            series[i] = L > R;
            break;
          case "gte":
            series[i] = L >= R;
            break;
          case "lt":
            series[i] = L < R;
            break;
          case "lte":
            series[i] = L <= R;
            break;
          case "eq":
            series[i] = L === R;
            break;
          default:
            series[i] = false;
        }
      }
      break;
    }
    case "logic": {
      const inputs = node.inputs.map((id) => seriesFor(id, nodesById, params, bars, upto, cache));
      series = new Array(upto + 1);
      for (let i = 0; i <= upto; i++) {
        if (node.op === "not") {
          const v = inputs[0][i];
          series[i] = v === true ? false : v === false ? true : false;
        } else if (node.op === "and") {
          let ok = true;
          for (const s of inputs) {
            if (s[i] !== true) {
              ok = false;
              break;
            }
          }
          series[i] = ok;
        } else if (node.op === "or") {
          let ok = false;
          for (const s of inputs) {
            if (s[i] === true) {
              ok = true;
              break;
            }
          }
          series[i] = ok;
        } else series[i] = false;
      }
      break;
    }
    case "cross": {
      const left = seriesFor(node.left, nodesById, params, bars, upto, cache);
      const right = seriesFor(node.right, nodesById, params, bars, upto, cache);
      series = new Array(upto + 1);
      series[0] = false;
      for (let i = 1; i <= upto; i++) {
        const l0 = left[i - 1];
        const r0 = right[i - 1];
        const l1 = left[i];
        const r1 = right[i];
        if (
          l0 == null ||
          r0 == null ||
          l1 == null ||
          r1 == null ||
          !isFiniteNumber(l0) ||
          !isFiniteNumber(r0) ||
          !isFiniteNumber(l1) ||
          !isFiniteNumber(r1)
        ) {
          series[i] = false;
          continue;
        }
        if (node.direction === "above") {
          series[i] = l0 <= r0 && l1 > r1;
        } else {
          series[i] = l0 >= r0 && l1 < r1;
        }
      }
      break;
    }
    default:
      throw new Error(`unknown node type ${node.type}`);
  }

  cache.set(nodeId, series);
  return series;
}

/**
 * Compile a validated strategy into a pure evaluate(bars, index) hot path.
 * parameterOverrides are applied via the schema grid before compile.
 */
export function compileStrategy(input, parameterOverrides = {}) {
  let strategy = normalizeStrategy(input);
  if (parameterOverrides && Object.keys(parameterOverrides).length) {
    strategy = applyParameterOverrides(strategy, parameterOverrides);
  }

  const nodesById = new Map(strategy.nodes.map((n) => [n.id, n]));
  const nodeOrder = Object.freeze(topoOrder(strategy.nodes));
  const params = strategy.parameters;
  const required = new Set(
    strategy.nodes
      .filter((node) => node.type === "input")
      .map((node) => node.field),
  );
  if (strategy.nodes.some((node) => node.type === "indicator" && node.indicator === "atr")) {
    for (const field of ["open", "high", "low", "close"]) required.add(field);
  }
  const requiredSeries = Object.freeze([...required].sort());
  const compiledStrategyHash = strategyHash(strategy);

  function resultAt(cache, index) {
    const values = {};
    for (const id of nodeOrder) {
      const series = cache.get(id);
      values[id] = series[index];
    }
    const signalOf = (ruleId) => ruleId != null && values[ruleId] === true;
    return {
      values,
      signals: {
        entryLong: signalOf(strategy.rules.entryLong),
        entryShort: signalOf(strategy.rules.entryShort),
        exitLong: signalOf(strategy.rules.exitLong),
        exitShort: signalOf(strategy.rules.exitShort),
      },
    };
  }

  function buildCache(bars, index) {
    assertBars(bars, index);
    const cache = new Map();
    for (const id of nodeOrder) {
      seriesFor(id, nodesById, params, bars, index, cache);
    }
    return cache;
  }

  function evaluate(bars, index) {
    return resultAt(buildCache(bars, index), index);
  }

  function evaluateAll(bars) {
    if (!Array.isArray(bars) || bars.length === 0) {
      throw new TypeError("bars must be a non-empty array");
    }
    const last = bars.length - 1;
    const cache = buildCache(bars, last);
    return Object.freeze(
      bars.map((_, index) => Object.freeze(resultAt(cache, index))),
    );
  }

  return Object.freeze({
    strategy,
    strategyHash: compiledStrategyHash,
    compilerVersion: STRATEGY_COMPILER_VERSION,
    compilerHash: STRATEGY_COMPILER_HASH,
    requiredSeries,
    nodeOrder,
    evaluate,
    evaluateAll,
  });
}
