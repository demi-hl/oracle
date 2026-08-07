import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareStrategyLiveHandoff } from "../src/strategy/handoff.mjs";
import { compileStrategy, STRATEGY_COMPILER_HASH, STRATEGY_COMPILER_VERSION } from "../src/strategy/compiler.mjs";
import { assertPreparedEnvelope } from "../src/prepare-envelope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function risk(extra = {}) {
  return {
    maxLeverage: 5,
    maxNotionalUsd: 1000,
    positionSizePct: 10,
    stopLossPct: 2,
    takeProfitPct: 4,
    cooldownBars: 3,
    maxDailyLossPct: 5,
    expiresAt: 1_900_000_000_000,
    ...extra,
  };
}

function baseStrategy(extra = {}) {
  return {
    version: 1,
    id: "ema-hand",
    name: "EMA Hand",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "15m" },
    parameters: {
      fast: { value: 3, min: 2, max: 20, step: 1 },
    },
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "fastEma", type: "indicator", indicator: "ema", input: "c", period: { param: "fast" } },
      { id: "k", type: "constant", value: 0 },
      { id: "gt", type: "compare", op: "gt", left: "fastEma", right: "k" },
    ],
    rules: {
      entryLong: "gt",
      entryShort: null,
      exitLong: null,
      exitShort: null,
    },
    risk: risk(),
    ...extra,
  };
}

function goodCaps(strategy, nowMs, extra = {}) {
  return {
    perStrategyNotionalUsd: Math.min(500, strategy.risk.maxNotionalUsd),
    maxLeverage: Math.min(3, strategy.risk.maxLeverage),
    dailyLossCapUsd: 50,
    chainAllowlist: ["hyperliquid"],
    assetAllowlist: [strategy.market.coin],
    expiresAt: nowMs + 60_000,
    killSwitchRequired: true,
    ...extra,
  };
}

function goodEvidence(compiled, extra = {}) {
  return {
    id: "ev-pass-1",
    status: "pass_live_eligible",
    strategyHash: compiled.strategyHash,
    compilerHash: compiled.compilerHash,
    ...extra,
  };
}

test("prepareStrategyLiveHandoff returns stamped prepare-only envelope", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  const env = { ...process.env };
  delete env.ORACLE_STAMP_HMAC_SECRET;
  delete env.ORACLE_STAMP_REQUIRE_MAC;
  const prepared = prepareStrategyLiveHandoff({
    strategy,
    evidence: goodEvidence(compiled),
    caps: goodCaps(strategy, nowMs),
    nowMs,
    env,
  });
  assert.equal(prepared.oraclePrepared, true);
  assert.equal(prepared.provider, "hl-strategy");
  assert.equal(prepared.kind, "strategy-live-handoff");
  assert.equal(prepared.requiresUserSignature, true);
  assert.equal(prepared.signingReady, false);
  assert.equal(prepared.broadcastReady, false);
  assert.equal(prepared.executionReady, false);
  assert.equal(prepared.strategyHash, compiled.strategyHash);
  assert.equal(prepared.compilerHash, STRATEGY_COMPILER_HASH);
  assert.deepEqual(prepared.evidence, {
    id: "ev-pass-1",
    status: "pass_live_eligible",
    strategyHash: compiled.strategyHash,
    compilerHash: compiled.compilerHash,
  });
  assert.equal(prepared.compiled.strategyHash, compiled.strategyHash);
  assert.equal(prepared.compiled.compilerHash, compiled.compilerHash);
  assert.equal(prepared.compiled.compilerVersion, STRATEGY_COMPILER_VERSION);
  assert.equal(prepared.compiled.venue, "hyperliquid");
  assert.equal(prepared.compiled.market.coin, "BTC");
  assert.ok(prepared.compiled.risk);
  assert.ok(prepared.compiled.strategy);
  assert.equal(prepared.arming.liveBroadcast, false);
  assert.equal(prepared.arming.requiresExplicitUserArm, true);
  assert.equal(prepared.arming.caps.killSwitchRequired, true);
  assert.equal(prepared.arming.caps.perStrategyNotionalUsd, 500);
  assertPreparedEnvelope(prepared, { nowMs: prepared.preparedAt + 10, env });
  // no function values
  const walk = (v) => {
    if (typeof v === "function") assert.fail("function value in prepared artifact");
    if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(prepared);
});

test("handoff mutation breaks assertPreparedEnvelope", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  const env = {};
  const prepared = prepareStrategyLiveHandoff({
    strategy,
    evidence: goodEvidence(compiled),
    caps: goodCaps(strategy, nowMs),
    nowMs,
    env,
  });
  const mutated = { ...prepared, arming: { ...prepared.arming, liveBroadcast: true } };
  assert.throws(() => assertPreparedEnvelope(mutated, { nowMs: prepared.preparedAt + 10, env }), /prepareHash|altered/i);
});

test("handoff status paper or fail rejected", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  for (const status of ["paper", "fail", "pass_paper", "fail_live"]) {
    assert.throws(
      () =>
        prepareStrategyLiveHandoff({
          strategy,
          evidence: goodEvidence(compiled, { status }),
          caps: goodCaps(strategy, nowMs),
          nowMs,
          env: {},
        }),
      /pass_live_eligible|status|evidence/i,
    );
  }
});

test("every cap missing empty allowlist expired cap mismatched hash rejected", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  const base = {
    strategy,
    evidence: goodEvidence(compiled),
    caps: goodCaps(strategy, nowMs),
    nowMs,
    env: {},
  };
  const requiredCaps = [
    "perStrategyNotionalUsd",
    "maxLeverage",
    "dailyLossCapUsd",
    "chainAllowlist",
    "assetAllowlist",
    "expiresAt",
    "killSwitchRequired",
  ];
  for (const key of requiredCaps) {
    const caps = { ...base.caps };
    delete caps[key];
    assert.throws(() => prepareStrategyLiveHandoff({ ...base, caps }), new RegExp(key, "i"));
  }
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, caps: { ...base.caps, chainAllowlist: [] } }),
    /chainAllowlist/i,
  );
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, caps: { ...base.caps, assetAllowlist: [] } }),
    /assetAllowlist/i,
  );
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, caps: { ...base.caps, chainAllowlist: ["ethereum"] } }),
    /hyperliquid|chainAllowlist/i,
  );
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, caps: { ...base.caps, assetAllowlist: ["ETH"] } }),
    /assetAllowlist|BTC/i,
  );
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, caps: { ...base.caps, expiresAt: nowMs } }),
    /expiresAt/i,
  );
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, caps: { ...base.caps, expiresAt: strategy.risk.expiresAt + 1 } }),
    /expiresAt/i,
  );
  assert.throws(
    () =>
      prepareStrategyLiveHandoff({
        ...base,
        evidence: goodEvidence(compiled, { strategyHash: "0".repeat(64) }),
      }),
    /strategyHash/i,
  );
  assert.throws(
    () =>
      prepareStrategyLiveHandoff({
        ...base,
        evidence: goodEvidence(compiled, { compilerHash: "0".repeat(64) }),
      }),
    /compilerHash/i,
  );
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, evidence: goodEvidence(compiled, { id: "" }) }),
    /evidence|id/i,
  );
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, caps: { ...base.caps, killSwitchRequired: false } }),
    /killSwitchRequired/i,
  );
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, caps: { ...base.caps, perStrategyNotionalUsd: 0 } }),
    /perStrategyNotionalUsd/i,
  );
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, caps: { ...base.caps, perStrategyNotionalUsd: 5000 } }),
    /perStrategyNotionalUsd|maxNotional/i,
  );
  assert.throws(
    () => prepareStrategyLiveHandoff({ ...base, caps: { ...base.caps, maxLeverage: 50 } }),
    /maxLeverage/i,
  );
});

test("public handoff flags always false even if caller supplies hostile extra fields", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  const prepared = prepareStrategyLiveHandoff({
    strategy,
    evidence: {
      ...goodEvidence(compiled),
      liveBroadcast: true,
      signingReady: true,
      broadcastReady: true,
      executionReady: true,
    },
    caps: {
      ...goodCaps(strategy, nowMs),
      liveBroadcast: true,
    },
    nowMs,
    env: { ORACLE_EXECUTE_ENABLED: "1" },
  });
  assert.equal(prepared.signingReady, false);
  assert.equal(prepared.broadcastReady, false);
  assert.equal(prepared.executionReady, false);
  assert.equal(prepared.arming.liveBroadcast, false);
  assert.equal(prepared.arming.requiresExplicitUserArm, true);
});

test("secret-like fields rejected without echoing values", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  const secret = "SUPER_SECRET_VALUE_9f3a";
  const cases = [
    { strategy: { ...strategy, privateKey: secret } },
    { strategy: { ...strategy, risk: { ...strategy.risk, secretKey: secret } } },
    { evidence: { ...goodEvidence(compiled), seed: secret } },
    { evidence: { ...goodEvidence(compiled), nested: { mnemonic: secret } } },
    { caps: { ...goodCaps(strategy, nowMs), password: secret } },
    { caps: { ...goodCaps(strategy, nowMs), credential: secret } },
    { caps: { ...goodCaps(strategy, nowMs), bearer: secret } },
    { caps: { ...goodCaps(strategy, nowMs), signature: secret } },
  ];
  for (const partial of cases) {
    let err;
    try {
      prepareStrategyLiveHandoff({
        strategy,
        evidence: goodEvidence(compiled),
        caps: goodCaps(strategy, nowMs),
        nowMs,
        env: {},
        ...partial,
      });
      assert.fail("expected throw");
    } catch (e) {
      err = e;
    }
    assert.ok(err, "expected error");
    assert.equal(String(err.message).includes(secret), false, "must not echo secret value");
    assert.match(String(err.message), /secret|forbidden|privateKey|mnemonic|credential|password|signature|bearer|seed/i);
  }
});

test("public package never evaluates ORACLE_EXECUTE_ENABLED in handoff source", () => {
  const src = fs.readFileSync(path.join(HERE, "../src/strategy/handoff.mjs"), "utf8");
  assert.equal(src.includes("ORACLE_EXECUTE_ENABLED"), false);
  assert.equal(/liveBroadcast\s*:\s*true/.test(src), false);
  assert.equal(/signingReady\s*:\s*true/.test(src), false);
  assert.equal(/broadcastReady\s*:\s*true/.test(src), false);
  assert.equal(/executionReady\s*:\s*true/.test(src), false);
});

test("static recursive import graph from handoff has no exec vault operator signer", () => {
  const root = path.join(HERE, "../src/strategy/handoff.mjs");
  const forbidden = ["hl-exec", "key-vault", "operator", "signer", "submit", "broadcast"];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    const specs = [
      ...src.matchAll(/^\s*import\s+[^'"]*from\s+["']([^"']+)["']/gm),
      ...src.matchAll(/^\s*export\s+[^'"]*from\s+["']([^"']+)["']/gm),
    ].map((m) => m[1]);
    for (const spec of specs) {
      for (const f of forbidden) {
        assert.equal(spec.includes(f), false, `${file} -> ${spec}`);
      }
      if (!spec.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), spec);
      for (const cand of [base, `${base}.mjs`, `${base}.js`]) {
        if (fs.existsSync(cand)) stack.push(cand);
      }
    }
  }
});

test("source and tests contain no em dash or en dash", () => {
  const src = fs.readFileSync(path.join(HERE, "../src/strategy/handoff.mjs"), "utf8");
  const testSrc = fs.readFileSync(new URL(import.meta.url), "utf8");
  for (const text of [src, testSrc]) {
    assert.equal(text.includes("\u2014"), false);
    assert.equal(text.includes("\u2013"), false);
  }
});
