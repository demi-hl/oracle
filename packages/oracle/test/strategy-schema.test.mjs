import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STRATEGY_VERSION,
  validateStrategy,
  normalizeStrategy,
  canonicalStrategyJson,
  strategyHash,
  applyParameterOverrides,
  StrategyValidationError,
} from "../src/strategy/schema.mjs";

function baseStrategy(overrides = {}) {
  return {
    version: 1,
    id: "ema-cross-btc",
    name: "EMA Cross BTC",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "15m" },
    parameters: {
      fast: { value: 9, min: 2, max: 50, step: 1 },
      slow: { value: 21, min: 5, max: 200, step: 1 },
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
    risk: {
      maxLeverage: 5,
      maxNotionalUsd: 1000,
      positionSizePct: 10,
      stopLossPct: 2,
      takeProfitPct: 4,
      cooldownBars: 3,
      maxDailyLossPct: 5,
      expiresAt: 1_900_000_000_000,
    },
    ...overrides,
  };
}

function assertHasPath(errors, path) {
  assert.ok(
    errors.some((e) => e.path === path),
    `expected error path ${path}, got ${JSON.stringify(errors)}`
  );
}

test("STRATEGY_VERSION is 1", () => {
  assert.equal(STRATEGY_VERSION, 1);
});

test("valid strategy normalizes and freezes deeply", () => {
  const input = baseStrategy();
  const result = validateStrategy(input);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.strategy);
  assert.ok(Object.isFrozen(result.strategy));
  assert.ok(Object.isFrozen(result.strategy.market));
  assert.ok(Object.isFrozen(result.strategy.parameters));
  assert.ok(Object.isFrozen(result.strategy.parameters.fast));
  assert.ok(Object.isFrozen(result.strategy.nodes));
  assert.ok(Object.isFrozen(result.strategy.nodes[0]));
  assert.ok(Object.isFrozen(result.strategy.rules));
  assert.ok(Object.isFrozen(result.strategy.risk));
  assert.equal(result.strategy.version, 1);
  assert.equal(result.strategy.id, "ema-cross-btc");
  assert.equal(result.strategy.venue, "hyperliquid");
  assert.equal(result.strategy.market.coin, "BTC");
  assert.equal(result.strategy.market.interval, "15m");
  assert.equal(result.strategy.rules.entryLong, "crossUp");
  assert.equal(result.strategy.rules.entryShort, null);

  const normalized = normalizeStrategy(input);
  assert.ok(Object.isFrozen(normalized));
  assert.equal(normalized.name, "EMA Cross BTC");
});

test("unknown top-level field rejects", () => {
  const r = validateStrategy(baseStrategy({ extra: true }));
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "extra");
  assert.equal(r.strategy, null);
});

test("unknown nested market field rejects", () => {
  const s = baseStrategy();
  s.market = { ...s.market, leverage: 10 };
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "market.leverage");
});

test("unknown risk field rejects", () => {
  const s = baseStrategy();
  s.risk = { ...s.risk, secretKey: "x" };
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "risk.secretKey");
});

test("unknown node field rejects", () => {
  const s = baseStrategy();
  s.nodes = s.nodes.map((n, i) => (i === 0 ? { ...n, note: "x" } : n));
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "nodes.0.note");
});

test("secret-shaped extra fields are rejected via unknown-field rule", () => {
  for (const field of ["privateKey", "apiKey", "seed", "mnemonic", "wallet"]) {
    const r = validateStrategy(baseStrategy({ [field]: "secret" }));
    assert.equal(r.ok, false, field);
    assertHasPath(r.errors, field);
  }
});

test("missing risk control rejects", () => {
  const s = baseStrategy();
  delete s.risk.stopLossPct;
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "risk.stopLossPct");
});

test("missing required top-level field rejects", () => {
  const s = baseStrategy();
  delete s.venue;
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "venue");
});

test("malformed strategy id rejects", () => {
  for (const id of ["", "A", "-bad", "bad id", "x".repeat(65)]) {
    const r = validateStrategy(baseStrategy({ id }));
    assert.equal(r.ok, false, id);
    assertHasPath(r.errors, "id");
  }
});

test("duplicate node ids reject", () => {
  const s = baseStrategy();
  s.nodes = [
    { id: "c", type: "input", field: "close" },
    { id: "c", type: "constant", value: 1 },
  ];
  s.rules = { entryLong: null, entryShort: null, exitLong: null, exitShort: null };
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /duplicate/i.test(e.message)));
});

test("missing node refs reject", () => {
  const s = baseStrategy();
  s.nodes = [
    { id: "c", type: "input", field: "close" },
    { id: "x", type: "compare", op: "gt", left: "c", right: "missing" },
  ];
  s.rules = { entryLong: "x", entryShort: null, exitLong: null, exitShort: null };
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /missing|unknown|ref/i.test(e.message)));
});

test("frozen invalid strategies cannot bypass canonical hash validation", () => {
  const invalid = Object.freeze({ version: 1, privateKey: "not-hashable" });
  assert.throws(() => canonicalStrategyJson(invalid), StrategyValidationError);
  assert.throws(() => strategyHash(invalid), StrategyValidationError);
});

test("numeric and boolean graph operands are type checked", () => {
  const s = baseStrategy();
  s.nodes = [
    { id: "c", type: "input", field: "close" },
    { id: "k", type: "constant", value: 1 },
    { id: "cmp", type: "compare", op: "gt", left: "c", right: "k" },
    { id: "bad", type: "cross", direction: "above", left: "cmp", right: "k" },
  ];
  s.rules = { entryLong: "bad", entryShort: null, exitLong: null, exitShort: null };
  const result = validateStrategy(s);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /numeric/i.test(error.message)));
});

test("cycles reject", () => {
  const s = baseStrategy();
  s.nodes = [
    { id: "a", type: "compare", op: "gt", left: "b", right: "b" },
    { id: "b", type: "logic", op: "not", inputs: ["a"] },
  ];
  s.rules = { entryLong: "a", entryShort: null, exitLong: null, exitShort: null };
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /cycle/i.test(e.message)));
});

test("indicator period parameters require positive integer value min max and step", () => {
  for (const definition of [
    { value: 0, min: 0, max: 50, step: 1 },
    { value: 2.5, min: 1, max: 50, step: 0.5 },
    { value: 2, min: 1.5, max: 50, step: 1 },
    { value: 2, min: 1, max: 50.5, step: 1 },
    { value: 2, min: 1, max: 50, step: 0.5 },
  ]) {
    const s = baseStrategy();
    s.parameters.fast = definition;
    const r = validateStrategy(s);
    assert.equal(r.ok, false, JSON.stringify(definition));
    assert.ok(r.errors.some((e) => e.path === "nodes.1.period.param"));
  }
});

test("invalid parameter grid rejects", () => {
  const s = baseStrategy();
  s.parameters = { fast: { value: 9, min: 10, max: 5, step: 1 } };
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.startsWith("parameters.fast")));
});

test("parameter value not on grid rejects", () => {
  const s = baseStrategy();
  s.parameters = { fast: { value: 9.5, min: 2, max: 50, step: 1 } };
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "parameters.fast.value");
});

test("out-of-grid override rejects", () => {
  const s = normalizeStrategy(baseStrategy());
  assert.throws(
    () => applyParameterOverrides(s, { fast: 9.5 }),
    (err) => err instanceof StrategyValidationError
  );
  assert.throws(
    () => applyParameterOverrides(s, { fast: 100 }),
    (err) => err instanceof StrategyValidationError
  );
  assert.throws(
    () => applyParameterOverrides(s, { unknown: 1 }),
    (err) => err instanceof StrategyValidationError
  );
});

test("in-grid override produces frozen normalized strategy", () => {
  const s = normalizeStrategy(baseStrategy());
  const next = applyParameterOverrides(s, { fast: 12 });
  assert.ok(Object.isFrozen(next));
  assert.equal(next.parameters.fast.value, 12);
  assert.equal(s.parameters.fast.value, 9);
});

test("key order does not change hash, node array order does", () => {
  const a = baseStrategy();
  const b = {
    risk: a.risk,
    rules: a.rules,
    nodes: a.nodes,
    parameters: a.parameters,
    market: a.market,
    venue: a.venue,
    name: a.name,
    id: a.id,
    version: a.version,
  };
  assert.equal(strategyHash(a), strategyHash(b));
  assert.equal(canonicalStrategyJson(a), canonicalStrategyJson(b));

  const c = baseStrategy();
  c.nodes = [...a.nodes].reverse();
  // reverse breaks refs for some nodes but hash of validated form differs by array order
  // Compare canonical of two valid strategies that differ only by node order with same ids:
  // Build two strategies with same nodes in different order that remain valid.
  const n1 = [
    { id: "c", type: "input", field: "close" },
    { id: "k", type: "constant", value: 1 },
    { id: "cmp", type: "compare", op: "gt", left: "c", right: "k" },
  ];
  const n2 = [
    { id: "k", type: "constant", value: 1 },
    { id: "c", type: "input", field: "close" },
    { id: "cmp", type: "compare", op: "gt", left: "c", right: "k" },
  ];
  const s1 = baseStrategy({
    nodes: n1,
    rules: { entryLong: "cmp", entryShort: null, exitLong: null, exitShort: null },
    parameters: {},
  });
  const s2 = baseStrategy({
    nodes: n2,
    rules: { entryLong: "cmp", entryShort: null, exitLong: null, exitShort: null },
    parameters: {},
  });
  assert.notEqual(strategyHash(s1), strategyHash(s2));
});

test("explicit nowMs rejects expiry at or before now", () => {
  const s = baseStrategy();
  s.risk = { ...s.risk, expiresAt: 1_000 };
  const okShape = validateStrategy(s);
  assert.equal(okShape.ok, true);

  const r = validateStrategy(s, { nowMs: 1_000 });
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "risk.expiresAt");

  const r2 = validateStrategy(s, { nowMs: 1_001 });
  assert.equal(r2.ok, false);

  const r3 = validateStrategy(baseStrategy({ risk: { ...s.risk, expiresAt: 2_000 } }), { nowMs: 1_000 });
  assert.equal(r3.ok, true);
});

test("rule pointing to a numeric node rejects", () => {
  const s = baseStrategy();
  s.rules = { entryLong: "c", entryShort: null, exitLong: null, exitShort: null };
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.startsWith("rules.entryLong") || /boolean|numeric|input|type/i.test(e.message)));
});

test("rule pointing to constant or indicator rejects", () => {
  const s = baseStrategy();
  s.rules = { entryLong: "fastEma", entryShort: null, exitLong: null, exitShort: null };
  const r = validateStrategy(s);
  assert.equal(r.ok, false);

  const s2 = baseStrategy();
  s2.nodes = [
    { id: "k", type: "constant", value: 1 },
    { id: "c", type: "input", field: "close" },
    { id: "cmp", type: "compare", op: "gt", left: "c", right: "k" },
  ];
  s2.rules = { entryLong: "k", entryShort: null, exitLong: null, exitShort: null };
  s2.parameters = {};
  const r2 = validateStrategy(s2);
  assert.equal(r2.ok, false);
});

test("normalizeStrategy throws StrategyValidationError", () => {
  assert.throws(
    () => normalizeStrategy(baseStrategy({ venue: "binance" })),
    (err) => err instanceof StrategyValidationError && Array.isArray(err.errors)
  );
});

test("strategyHash is 64 lowercase hex", () => {
  const h = strategyHash(baseStrategy());
  assert.match(h, /^[0-9a-f]{64}$/);
});

test("empty name rejects", () => {
  const r = validateStrategy(baseStrategy({ name: "" }));
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "name");
});

test("invalid interval rejects", () => {
  const s = baseStrategy();
  s.market = { coin: "BTC", interval: "7m" };
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "market.interval");
});

test("risk bounds reject", () => {
  const cases = [
    ["maxLeverage", 0],
    ["maxLeverage", 51],
    ["maxNotionalUsd", 0],
    ["positionSizePct", 0],
    ["positionSizePct", 101],
    ["stopLossPct", 0],
    ["takeProfitPct", 0],
    ["takeProfitPct", 1001],
    ["cooldownBars", -1],
    ["maxDailyLossPct", 0],
    ["expiresAt", 0],
  ];
  for (const [field, value] of cases) {
    const s = baseStrategy();
    s.risk = { ...s.risk, [field]: value };
    const r = validateStrategy(s);
    assert.equal(r.ok, false, `${field}=${value}`);
    assertHasPath(r.errors, `risk.${field}`);
  }
});

test("too many parameters reject", () => {
  const s = baseStrategy();
  const parameters = {};
  for (let i = 0; i < 17; i++) parameters[`p${i}`] = { value: 1, min: 1, max: 10, step: 1 };
  s.parameters = parameters;
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "parameters");
});

test("too many nodes reject", () => {
  const s = baseStrategy();
  const nodes = [];
  for (let i = 0; i < 129; i++) nodes.push({ id: `n${i}`, type: "constant", value: i });
  s.nodes = nodes;
  s.rules = { entryLong: null, entryShort: null, exitLong: null, exitShort: null };
  s.parameters = {};
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assertHasPath(r.errors, "nodes");
});

test("macd output required and bollinger output required", () => {
  const s = baseStrategy();
  s.nodes = [
    { id: "c", type: "input", field: "close" },
    { id: "m", type: "indicator", indicator: "macd", input: "c", fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  ];
  s.rules = { entryLong: null, entryShort: null, exitLong: null, exitShort: null };
  s.parameters = {};
  const r = validateStrategy(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.includes("output") || /output/i.test(e.message)));

  const s2 = baseStrategy();
  s2.nodes = [
    { id: "c", type: "input", field: "close" },
    { id: "b", type: "indicator", indicator: "bollinger", input: "c", period: 20, stdDev: 2 },
  ];
  s2.rules = { entryLong: null, entryShort: null, exitLong: null, exitShort: null };
  s2.parameters = {};
  const r2 = validateStrategy(s2);
  assert.equal(r2.ok, false);
});

test("logic not requires exactly one input; and/or at least two", () => {
  const badNot = baseStrategy({
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "k", type: "constant", value: 1 },
      { id: "cmp", type: "compare", op: "gt", left: "c", right: "k" },
      { id: "n", type: "logic", op: "not", inputs: ["cmp", "cmp"] },
    ],
    rules: { entryLong: "n", entryShort: null, exitLong: null, exitShort: null },
  });
  assert.equal(validateStrategy(badNot).ok, false);

  const badAnd = baseStrategy({
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "k", type: "constant", value: 1 },
      { id: "cmp", type: "compare", op: "gt", left: "c", right: "k" },
      { id: "a", type: "logic", op: "and", inputs: ["cmp"] },
    ],
    rules: { entryLong: "a", entryShort: null, exitLong: null, exitShort: null },
  });
  assert.equal(validateStrategy(badAnd).ok, false);
});

test("non-object input rejects without throw", () => {
  for (const v of [null, undefined, 1, "x", []]) {
    const r = validateStrategy(v);
    assert.equal(r.ok, false);
    assert.equal(r.strategy, null);
  }
});
