// Deterministic Hyperliquid strategy DSL schema. Fail-closed, no I/O, no clock.

import { createHash } from "node:crypto";

export const STRATEGY_VERSION = 1;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Node ids are free-form unique labels; allow camelCase used by authors.
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INTERVALS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d"]);
const INPUT_FIELDS = new Set(["open", "high", "low", "close", "volume", "fundingRate", "openInterest"]);
const INDICATORS = new Set(["sma", "ema", "rsi", "macd", "bollinger", "atr"]);
const COMPARE_OPS = new Set(["gt", "gte", "lt", "lte", "eq"]);
const LOGIC_OPS = new Set(["and", "or", "not"]);
const CROSS_DIRS = new Set(["above", "below"]);
const MACD_OUTPUTS = new Set(["line", "signal", "histogram"]);
const BOLLINGER_OUTPUTS = new Set(["upper", "middle", "lower"]);
const BOOLEAN_NODE_TYPES = new Set(["compare", "logic", "cross"]);
const TOP_LEVEL_KEYS = new Set([
  "version",
  "id",
  "name",
  "venue",
  "market",
  "parameters",
  "nodes",
  "rules",
  "risk",
]);
const MARKET_KEYS = new Set(["coin", "interval"]);
const PARAM_KEYS = new Set(["value", "min", "max", "step"]);
const RULE_KEYS = new Set(["entryLong", "entryShort", "exitLong", "exitShort"]);
const RISK_KEYS = new Set([
  "maxLeverage",
  "maxNotionalUsd",
  "positionSizePct",
  "stopLossPct",
  "takeProfitPct",
  "cooldownBars",
  "maxDailyLossPct",
  "expiresAt",
]);
const NODE_BASE = new Set(["id", "type"]);
const NODE_KEYS = {
  input: new Set(["id", "type", "field"]),
  constant: new Set(["id", "type", "value"]),
  indicator: new Set([
    "id",
    "type",
    "indicator",
    "input",
    "period",
    "fastPeriod",
    "slowPeriod",
    "signalPeriod",
    "stdDev",
    "output",
  ]),
  compare: new Set(["id", "type", "op", "left", "right"]),
  logic: new Set(["id", "type", "op", "inputs"]),
  cross: new Set(["id", "type", "direction", "left", "right"]),
};

const MAX_PARAMS = 16;
const MAX_NODES = 128;
const MAX_NAME = 100;
const MAX_COIN = 32;

export class StrategyValidationError extends Error {
  constructor(errors) {
    const lines = errors.map((e) => `${e.path}: ${e.message}`);
    super(
      `invalid strategy (${errors.length} error${errors.length === 1 ? "" : "s"}): ${lines.join("; ")}`
    );
    this.name = "StrategyValidationError";
    this.errors = errors;
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
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

function push(errors, path, message) {
  errors.push({ path, message });
}

function unknownFields(obj, allowed, path, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) push(errors, path ? `${path}.${key}` : key, "unknown field is not allowed");
  }
}

function onGrid(value, min, max, step) {
  if (!isFiniteNumber(value) || !isFiniteNumber(min) || !isFiniteNumber(max) || !isFiniteNumber(step)) {
    return false;
  }
  if (step <= 0) return false;
  if (value < min || value > max) return false;
  // Integer-safe grid check via scaled remainder.
  const n = (value - min) / step;
  if (!Number.isFinite(n)) return false;
  const nearest = Math.round(n);
  return Math.abs(n - nearest) <= 1e-9;
}

function resolvePeriodLike(raw, path, parameters, errors) {
  if (isPlainObject(raw)) {
    unknownFields(raw, new Set(["param"]), path, errors);
    if (typeof raw.param !== "string" || !raw.param) {
      push(errors, `${path}.param`, "must be a parameter name string");
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(parameters, raw.param)) {
      push(errors, `${path}.param`, `unknown parameter "${raw.param}"`);
      return null;
    }
    return { param: raw.param };
  }
  if (!isPositiveInt(raw)) {
    push(errors, path, "must be a positive integer or {param}");
    return null;
  }
  return raw;
}

function resolveConstantValue(raw, path, parameters, errors) {
  if (isPlainObject(raw)) {
    unknownFields(raw, new Set(["param"]), path, errors);
    if (typeof raw.param !== "string" || !raw.param) {
      push(errors, `${path}.param`, "must be a parameter name string");
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(parameters, raw.param)) {
      push(errors, `${path}.param`, `unknown parameter "${raw.param}"`);
      return null;
    }
    return { param: raw.param };
  }
  if (!isFiniteNumber(raw)) {
    push(errors, path, "must be a finite number or {param}");
    return null;
  }
  return raw;
}

function nodeDeps(node) {
  switch (node.type) {
    case "input":
    case "constant":
      return [];
    case "indicator":
      return node.input ? [node.input] : [];
    case "compare":
    case "cross":
      return [node.left, node.right].filter(Boolean);
    case "logic":
      return Array.isArray(node.inputs) ? [...node.inputs] : [];
    default:
      return [];
  }
}

function detectCycle(nodesById) {
  const state = new Map(); // 0 unvisited, 1 visiting, 2 done
  const visit = (id) => {
    const s = state.get(id) || 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    const node = nodesById.get(id);
    if (node) {
      for (const dep of nodeDeps(node)) {
        if (nodesById.has(dep) && visit(dep)) return true;
      }
    }
    state.set(id, 2);
    return false;
  };
  for (const id of nodesById.keys()) {
    if (visit(id)) return true;
  }
  return false;
}

function validateParameters(raw, errors) {
  if (!isPlainObject(raw)) {
    push(errors, "parameters", "must be a plain object");
    return null;
  }
  const keys = Object.keys(raw);
  if (keys.length > MAX_PARAMS) {
    push(errors, "parameters", `too many parameters (max ${MAX_PARAMS})`);
    return null;
  }
  const out = {};
  for (const name of keys) {
    if (!ID_RE.test(name)) {
      push(errors, `parameters.${name}`, "parameter name is malformed");
      continue;
    }
    const p = raw[name];
    const path = `parameters.${name}`;
    if (!isPlainObject(p)) {
      push(errors, path, "must be a plain object");
      continue;
    }
    unknownFields(p, PARAM_KEYS, path, errors);
    for (const k of PARAM_KEYS) {
      if (!(k in p)) push(errors, `${path}.${k}`, "required field is missing");
    }
    const { value, min, max, step } = p;
    if (!isFiniteNumber(min)) push(errors, `${path}.min`, "must be a finite number");
    if (!isFiniteNumber(max)) push(errors, `${path}.max`, "must be a finite number");
    if (!isFiniteNumber(step) || step <= 0) push(errors, `${path}.step`, "must be a positive finite number");
    if (!isFiniteNumber(value)) push(errors, `${path}.value`, "must be a finite number");
    if (isFiniteNumber(min) && isFiniteNumber(max) && min > max) {
      push(errors, `${path}.min`, "min must be <= max");
    }
    if (
      isFiniteNumber(value) &&
      isFiniteNumber(min) &&
      isFiniteNumber(max) &&
      isFiniteNumber(step) &&
      step > 0
    ) {
      if (!onGrid(value, min, max, step)) {
        push(errors, `${path}.value`, "value must lie on the declared min/max/step grid");
      }
    }
    out[name] = { value, min, max, step };
  }
  return out;
}

function validateNode(node, index, parameters, errors) {
  const path = `nodes.${index}`;
  if (!isPlainObject(node)) {
    push(errors, path, "must be a plain object");
    return null;
  }
  if (typeof node.type !== "string" || !NODE_KEYS[node.type]) {
    push(errors, `${path}.type`, "unknown or missing node type");
    unknownFields(node, NODE_BASE, path, errors);
    return null;
  }
  unknownFields(node, NODE_KEYS[node.type], path, errors);
  if (typeof node.id !== "string" || !NODE_ID_RE.test(node.id)) {
    push(errors, `${path}.id`, "must be a 1-64 char id starting with alphanumeric");
  }

  switch (node.type) {
    case "input": {
      if (typeof node.field !== "string" || !INPUT_FIELDS.has(node.field)) {
        push(errors, `${path}.field`, "must be one of open|high|low|close|volume|fundingRate|openInterest");
      }
      return { id: node.id, type: "input", field: node.field };
    }
    case "constant": {
      const value = resolveConstantValue(node.value, `${path}.value`, parameters, errors);
      return { id: node.id, type: "constant", value };
    }
    case "indicator": {
      if (typeof node.indicator !== "string" || !INDICATORS.has(node.indicator)) {
        push(errors, `${path}.indicator`, "must be one of sma|ema|rsi|macd|bollinger|atr");
      }
      const ind = node.indicator;
      const out = { id: node.id, type: "indicator", indicator: ind };

      if (ind === "atr") {
        // ATR may name an input but computes true range from bars.
        if ("input" in node) {
          if (typeof node.input !== "string" || !node.input) {
            push(errors, `${path}.input`, "must be a node id string when provided");
          } else out.input = node.input;
        }
        const period = resolvePeriodLike(node.period, `${path}.period`, parameters, errors);
        if (period != null) out.period = period;
      } else {
        if (typeof node.input !== "string" || !node.input) {
          push(errors, `${path}.input`, "must be a node id string");
        } else out.input = node.input;
      }

      if (ind === "sma" || ind === "ema" || ind === "rsi" || ind === "bollinger" || ind === "atr") {
        if (!("period" in node) && ind !== "atr") {
          // atr handled above; others require period
        }
        if (ind !== "macd") {
          if (!("period" in node)) push(errors, `${path}.period`, "required field is missing");
          else {
            const period = resolvePeriodLike(node.period, `${path}.period`, parameters, errors);
            if (period != null) out.period = period;
          }
        }
      }

      if (ind === "macd") {
        for (const k of ["fastPeriod", "slowPeriod", "signalPeriod"]) {
          if (!(k in node)) push(errors, `${path}.${k}`, "required field is missing");
          else {
            const v = resolvePeriodLike(node[k], `${path}.${k}`, parameters, errors);
            if (v != null) out[k] = v;
          }
        }
        if (!("output" in node)) push(errors, `${path}.output`, "required field is missing");
        else if (!MACD_OUTPUTS.has(node.output)) {
          push(errors, `${path}.output`, "must be line|signal|histogram");
        } else out.output = node.output;
        if ("period" in node) push(errors, `${path}.period`, "forbidden for macd");
        if ("stdDev" in node) push(errors, `${path}.stdDev`, "forbidden for macd");
      } else if (ind === "bollinger") {
        if (!("stdDev" in node)) push(errors, `${path}.stdDev`, "required field is missing");
        else {
          const sd = resolveConstantValue(node.stdDev, `${path}.stdDev`, parameters, errors);
          if (sd != null) {
            if (typeof sd === "number" && sd <= 0) push(errors, `${path}.stdDev`, "must be > 0");
            else out.stdDev = sd;
          }
        }
        if (!("output" in node)) push(errors, `${path}.output`, "required field is missing");
        else if (!BOLLINGER_OUTPUTS.has(node.output)) {
          push(errors, `${path}.output`, "must be upper|middle|lower");
        } else out.output = node.output;
        for (const k of ["fastPeriod", "slowPeriod", "signalPeriod"]) {
          if (k in node) push(errors, `${path}.${k}`, `forbidden for ${ind}`);
        }
      } else {
        if ("output" in node) push(errors, `${path}.output`, `forbidden for ${ind}`);
        if ("stdDev" in node && ind !== "bollinger") push(errors, `${path}.stdDev`, `forbidden for ${ind}`);
        for (const k of ["fastPeriod", "slowPeriod", "signalPeriod"]) {
          if (k in node) push(errors, `${path}.${k}`, `forbidden for ${ind}`);
        }
      }
      return out;
    }
    case "compare": {
      if (typeof node.op !== "string" || !COMPARE_OPS.has(node.op)) {
        push(errors, `${path}.op`, "must be gt|gte|lt|lte|eq");
      }
      if (typeof node.left !== "string" || !node.left) push(errors, `${path}.left`, "must be a node id");
      if (typeof node.right !== "string" || !node.right) push(errors, `${path}.right`, "must be a node id");
      return { id: node.id, type: "compare", op: node.op, left: node.left, right: node.right };
    }
    case "logic": {
      if (typeof node.op !== "string" || !LOGIC_OPS.has(node.op)) {
        push(errors, `${path}.op`, "must be and|or|not");
      }
      if (!Array.isArray(node.inputs)) {
        push(errors, `${path}.inputs`, "must be an array of node ids");
        return { id: node.id, type: "logic", op: node.op, inputs: [] };
      }
      const inputs = [];
      for (let i = 0; i < node.inputs.length; i++) {
        const ref = node.inputs[i];
        if (typeof ref !== "string" || !ref) push(errors, `${path}.inputs.${i}`, "must be a node id");
        else inputs.push(ref);
      }
      if (node.op === "not") {
        if (inputs.length !== 1) push(errors, `${path}.inputs`, "not requires exactly one input");
      } else if (node.op === "and" || node.op === "or") {
        if (inputs.length < 2) push(errors, `${path}.inputs`, `${node.op} requires at least two inputs`);
      }
      return { id: node.id, type: "logic", op: node.op, inputs };
    }
    case "cross": {
      if (typeof node.direction !== "string" || !CROSS_DIRS.has(node.direction)) {
        push(errors, `${path}.direction`, "must be above|below");
      }
      if (typeof node.left !== "string" || !node.left) push(errors, `${path}.left`, "must be a node id");
      if (typeof node.right !== "string" || !node.right) push(errors, `${path}.right`, "must be a node id");
      return {
        id: node.id,
        type: "cross",
        direction: node.direction,
        left: node.left,
        right: node.right,
      };
    }
    default:
      return null;
  }
}

function validateRisk(raw, errors, opts) {
  if (!isPlainObject(raw)) {
    push(errors, "risk", "must be a plain object");
    return null;
  }
  unknownFields(raw, RISK_KEYS, "risk", errors);
  for (const k of RISK_KEYS) {
    if (!(k in raw) || raw[k] == null) push(errors, `risk.${k}`, "required field is missing");
  }
  const out = {};

  const maxLeverage = raw.maxLeverage;
  if (!isFiniteNumber(maxLeverage) || maxLeverage <= 0 || maxLeverage > 50) {
    push(errors, "risk.maxLeverage", "must be a number > 0 and <= 50");
  } else out.maxLeverage = maxLeverage;

  const maxNotionalUsd = raw.maxNotionalUsd;
  if (!isFiniteNumber(maxNotionalUsd) || maxNotionalUsd <= 0) {
    push(errors, "risk.maxNotionalUsd", "must be a number > 0");
  } else out.maxNotionalUsd = maxNotionalUsd;

  const positionSizePct = raw.positionSizePct;
  if (!isFiniteNumber(positionSizePct) || positionSizePct <= 0 || positionSizePct > 100) {
    push(errors, "risk.positionSizePct", "must be a number > 0 and <= 100");
  } else out.positionSizePct = positionSizePct;

  const stopLossPct = raw.stopLossPct;
  if (!isFiniteNumber(stopLossPct) || stopLossPct <= 0 || stopLossPct > 100) {
    push(errors, "risk.stopLossPct", "must be a number > 0 and <= 100");
  } else out.stopLossPct = stopLossPct;

  const takeProfitPct = raw.takeProfitPct;
  if (!isFiniteNumber(takeProfitPct) || takeProfitPct <= 0 || takeProfitPct > 1000) {
    push(errors, "risk.takeProfitPct", "must be a number > 0 and <= 1000");
  } else out.takeProfitPct = takeProfitPct;

  const cooldownBars = raw.cooldownBars;
  if (!Number.isInteger(cooldownBars) || cooldownBars < 0 || cooldownBars > 100000) {
    push(errors, "risk.cooldownBars", "must be an integer >= 0 and <= 100000");
  } else out.cooldownBars = cooldownBars;

  const maxDailyLossPct = raw.maxDailyLossPct;
  if (!isFiniteNumber(maxDailyLossPct) || maxDailyLossPct <= 0 || maxDailyLossPct > 100) {
    push(errors, "risk.maxDailyLossPct", "must be a number > 0 and <= 100");
  } else out.maxDailyLossPct = maxDailyLossPct;

  const expiresAt = raw.expiresAt;
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) {
    push(errors, "risk.expiresAt", "must be an integer epoch milliseconds > 0");
  } else {
    if (opts.nowMs !== undefined) {
      if (!Number.isInteger(opts.nowMs)) {
        push(errors, "nowMs", "must be an integer epoch milliseconds");
      } else if (expiresAt <= opts.nowMs) {
        push(errors, "risk.expiresAt", "must be strictly greater than nowMs");
      }
    }
    out.expiresAt = expiresAt;
  }

  return out;
}

/**
 * Validate a strategy. Never throws.
 * opts.nowMs — when provided, risk.expiresAt must be strictly greater.
 */
export function validateStrategy(input, opts = {}) {
  const errors = [];

  if (!isPlainObject(input)) {
    push(errors, "", "strategy must be a plain object");
    return { ok: false, errors, strategy: null };
  }

  unknownFields(input, TOP_LEVEL_KEYS, "", errors);

  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in input) || input[key] == null) push(errors, key, "required field is missing");
  }

  // version
  if (input.version !== STRATEGY_VERSION) {
    push(errors, "version", `must be ${STRATEGY_VERSION}`);
  }

  // id
  if (typeof input.id !== "string" || !ID_RE.test(input.id)) {
    push(errors, "id", "must match /^[a-z0-9][a-z0-9._-]{0,63}$/");
  }

  // name
  if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > MAX_NAME) {
    push(errors, "name", `must be a non-empty string max ${MAX_NAME}`);
  }

  // venue
  if (input.venue !== "hyperliquid") {
    push(errors, "venue", 'must be "hyperliquid"');
  }

  // market
  let market = null;
  if (!isPlainObject(input.market)) {
    push(errors, "market", "must be a plain object");
  } else {
    unknownFields(input.market, MARKET_KEYS, "market", errors);
    if (typeof input.market.coin !== "string" || input.market.coin.length === 0 || input.market.coin.length > MAX_COIN) {
      push(errors, "market.coin", `must be a non-empty string max ${MAX_COIN}`);
    }
    if (typeof input.market.interval !== "string" || !INTERVALS.has(input.market.interval)) {
      push(errors, "market.interval", "must be a supported interval");
    }
    market = { coin: input.market.coin, interval: input.market.interval };
  }

  const parameters = validateParameters(input.parameters, errors);

  // nodes
  let nodes = null;
  const nodesById = new Map();
  if (!Array.isArray(input.nodes)) {
    push(errors, "nodes", "must be an array");
  } else if (input.nodes.length > MAX_NODES) {
    push(errors, "nodes", `too many nodes (max ${MAX_NODES})`);
  } else {
    nodes = [];
    for (let i = 0; i < input.nodes.length; i++) {
      const n = validateNode(input.nodes[i], i, parameters || {}, errors);
      if (!n) continue;
      if (typeof n.id === "string" && NODE_ID_RE.test(n.id)) {
        if (nodesById.has(n.id)) {
          push(errors, `nodes.${i}.id`, `duplicate node id "${n.id}"`);
        } else {
          nodesById.set(n.id, n);
        }
      }
      nodes.push(n);
    }

    // ref checks
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const path = `nodes.${i}`;
      for (const dep of nodeDeps(n)) {
        if (!nodesById.has(dep)) {
          push(errors, path, `unknown node ref "${dep}"`);
        }
      }
    }

    if (detectCycle(nodesById)) {
      push(errors, "nodes", "graph contains a cycle");
    }
  }

  // rules
  let rules = null;
  if (!isPlainObject(input.rules)) {
    push(errors, "rules", "must be a plain object");
  } else {
    unknownFields(input.rules, RULE_KEYS, "rules", errors);
    for (const k of RULE_KEYS) {
      if (!(k in input.rules)) push(errors, `rules.${k}`, "required field is missing");
    }
    rules = {};
    for (const k of RULE_KEYS) {
      const v = input.rules[k];
      if (v === null) {
        rules[k] = null;
        continue;
      }
      if (typeof v !== "string" || !v) {
        push(errors, `rules.${k}`, "must be a node id or null");
        rules[k] = v;
        continue;
      }
      if (!nodesById.has(v)) {
        push(errors, `rules.${k}`, `unknown node ref "${v}"`);
        rules[k] = v;
        continue;
      }
      const target = nodesById.get(v);
      if (!BOOLEAN_NODE_TYPES.has(target.type)) {
        push(errors, `rules.${k}`, `rule must reference a boolean node, not ${target.type}`);
      }
      rules[k] = v;
    }
  }

  const risk = validateRisk(input.risk, errors, opts);

  if (errors.length) return { ok: false, errors, strategy: null };

  const strategy = deepFreeze({
    version: STRATEGY_VERSION,
    id: input.id,
    name: input.name,
    venue: "hyperliquid",
    market,
    parameters,
    nodes,
    rules,
    risk,
  });

  return { ok: true, errors: [], strategy };
}

export function normalizeStrategy(input, opts = {}) {
  const result = validateStrategy(input, opts);
  if (!result.ok) throw new StrategyValidationError(result.errors);
  return result.strategy;
}

export function canonicalStrategyJson(input) {
  const strategy = typeof input?.version === "number" && Object.isFrozen(input)
    ? input
    : normalizeStrategy(input);
  return JSON.stringify(sortKeysDeep(strategy));
}

export function strategyHash(input) {
  const json = canonicalStrategyJson(input);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

export function applyParameterOverrides(strategy, overrides) {
  if (!isPlainObject(strategy)) throw new StrategyValidationError([{ path: "", message: "strategy must be a plain object" }]);
  if (!isPlainObject(overrides)) {
    throw new StrategyValidationError([{ path: "overrides", message: "must be a plain object" }]);
  }

  // Work from a plain clone of a normalized strategy.
  const base = normalizeStrategy(strategy);
  const nextParams = {};
  for (const [name, p] of Object.entries(base.parameters)) {
    nextParams[name] = { value: p.value, min: p.min, max: p.max, step: p.step };
  }

  const errors = [];
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.prototype.hasOwnProperty.call(nextParams, name)) {
      push(errors, name, `unknown parameter "${name}"`);
      continue;
    }
    const p = nextParams[name];
    if (!isFiniteNumber(value)) {
      push(errors, name, "override must be a finite number");
      continue;
    }
    if (!onGrid(value, p.min, p.max, p.step)) {
      push(errors, name, "override must lie on the declared min/max/step grid");
      continue;
    }
    nextParams[name] = { ...p, value };
  }
  if (errors.length) throw new StrategyValidationError(errors);

  return normalizeStrategy({
    version: base.version,
    id: base.id,
    name: base.name,
    venue: base.venue,
    market: { coin: base.market.coin, interval: base.market.interval },
    parameters: nextParams,
    nodes: base.nodes.map((n) => {
      const copy = { ...n };
      if (Array.isArray(n.inputs)) copy.inputs = [...n.inputs];
      return copy;
    }),
    rules: { ...base.rules },
    risk: { ...base.risk },
  });
}
