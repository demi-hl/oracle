import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareStrategyLiveHandoff as prepareStrategyLiveHandoffRaw } from "../src/strategy/handoff.mjs";
import { compileStrategy, STRATEGY_COMPILER_HASH, STRATEGY_COMPILER_VERSION } from "../src/strategy/compiler.mjs";
import { computeEvidenceArtifactId } from "../src/strategy/evidence.mjs";
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

function goodShadow(nowMs) {
  return {
    id: "shadow-runner-1",
    stateHash: "d".repeat(64),
    status: "running",
    cursor: nowMs - 2_000,
    updatedAt: nowMs - 1_000,
  };
}

function prepareHandoff(input) {
  return prepareStrategyLiveHandoffRaw({
    shadow: goodShadow(input.nowMs),
    ...input,
  });
}

function goodEvidence(compiled, extra = {}) {
  const body = {
    status: "pass_live_eligible",
    strategyHash: compiled.strategyHash,
    compilerHash: compiled.compilerHash,
    barsHash: "c".repeat(64),
    split: {
      trainStartIndex: 0,
      trainEndIndex: 69,
      trainBarCount: 70,
      holdoutStartIndex: 70,
      holdoutEndIndex: 99,
      holdoutBarCount: 30,
      trainFraction: 0.7,
    },
    train: {
      metrics: { netPnlUsd: 10, profitFactor: 2, maxDrawdownPct: 1, tradeCount: 10 },
      costs: {},
      tradeCount: 10,
    },
    holdout: {
      metrics: { netPnlUsd: 5, profitFactor: 2, maxDrawdownPct: 1, tradeCount: 5 },
      costs: {},
      tradeCount: 5,
    },
    walkForward: {
      passRate: 1,
      windowsRun: 1,
      windows: [{
        index: 0,
        trainStartIndex: 0,
        trainEndIndex: 69,
        evalStartIndex: 70,
        evalEndIndex: 99,
        passed: true,
        reason: "pass",
        metrics: { netPnlUsd: 5, profitFactor: 2, maxDrawdownPct: 1, tradeCount: 5 },
      }],
    },
    flags: [],
    ...extra,
  };
  return { id: computeEvidenceArtifactId(body), ...body };
}

test("prepareStrategyLiveHandoff returns stamped prepare-only envelope", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  const env = { ...process.env };
  delete env.ORACLE_STAMP_HMAC_SECRET;
  delete env.ORACLE_STAMP_REQUIRE_MAC;
  const prepared = prepareHandoff({
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
  assert.equal(prepared.evidence.id, goodEvidence(compiled).id);
  assert.equal(prepared.evidence.status, "pass_live_eligible");
  assert.equal(prepared.evidence.strategyHash, compiled.strategyHash);
  assert.equal(prepared.evidence.compilerHash, compiled.compilerHash);
  assert.ok(prepared.evidence.holdout);
  assert.deepEqual(prepared.shadow, goodShadow(nowMs));
  assert.equal(prepared.compiled.strategyHash, compiled.strategyHash);
  assert.equal(prepared.compiled.compilerHash, compiled.compilerHash);
  assert.equal(prepared.compiled.compilerVersion, STRATEGY_COMPILER_VERSION);
  assert.equal(prepared.compiled.venue, "hyperliquid");
  assert.equal(prepared.compiled.market.coin, "BTC");
  assert.equal(prepared.compiled.market.kind, "perp");
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

test("handoff requires a complete current shadow state binding", () => {
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
  assert.throws(() => prepareStrategyLiveHandoffRaw(base), /shadow.*required/i);
  assert.throws(
    () => prepareHandoff({ ...base, shadow: { ...goodShadow(nowMs), stateHash: "not-a-hash" } }),
    /shadow\.stateHash/i,
  );
});

test("handoff caps cannot widen daily loss or asset scope", () => {
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
  assert.throws(
    () => prepareHandoff({
      ...base,
      caps: { ...base.caps, dailyLossCapUsd: 51 },
    }),
    /dailyLossCapUsd/i,
  );
  assert.throws(
    () => prepareHandoff({
      ...base,
      caps: { ...base.caps, assetAllowlist: ["BTC", "ETH"] },
    }),
    /assetAllowlist/i,
  );
});

test("handoff mutation breaks assertPreparedEnvelope", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  const env = {};
  const prepared = prepareHandoff({
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
        prepareHandoff({
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

test("handoff rejects self-hashed live evidence with contradictory walk-forward facts", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  const evidence = goodEvidence(compiled, {
    walkForward: { passRate: 1, windowsRun: 1, windows: [] },
  });
  assert.throws(
    () => prepareHandoff({
      strategy,
      evidence,
      caps: goodCaps(strategy, nowMs),
      nowMs,
      env: {},
    }),
    /walk-forward|walkForward|windows/i,
  );

  const valid = goodEvidence(compiled);
  const cases = [
    {
      ...valid,
      split: { ...valid.split, holdoutStartIndex: valid.split.trainEndIndex },
    },
    {
      ...valid,
      walkForward: { ...valid.walkForward, passRate: 0 },
    },
    {
      ...valid,
      holdout: {
        ...valid.holdout,
        metrics: { ...valid.holdout.metrics, netPnlUsd: -1 },
      },
    },
    {
      ...valid,
      walkForward: {
        ...valid.walkForward,
        windows: valid.walkForward.windows.map((window) => ({
          ...window,
          metrics: { ...window.metrics, maxDrawdownPct: strategy.risk.maxDailyLossPct + 1 },
        })),
      },
    },
  ];
  for (const candidate of cases) {
    const body = { ...candidate };
    delete body.id;
    const selfHashed = { id: computeEvidenceArtifactId(body), ...body };
    assert.throws(
      () => prepareHandoff({
        strategy,
        evidence: selfHashed,
        caps: goodCaps(strategy, nowMs),
        nowMs,
        env: {},
      }),
      /evidence|split|holdout|walk-forward|walkForward|drawdown/i,
    );
  }
});

test("handoff rejects evidence ids that are not evidence artifact hashes", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  assert.throws(
    () => prepareHandoff({
      strategy,
      evidence: goodEvidence(compiled, { id: "caller-claimed-pass" }),
      caps: goodCaps(strategy, nowMs),
      nowMs,
      env: {},
    }),
    /evidence\.id/i,
  );
});

test("handoff rejects a caller-chosen sha256-shaped evidence id", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  const forged = { ...goodEvidence(compiled), id: "0".repeat(64) };
  assert.throws(
    () => prepareHandoff({
      strategy,
      evidence: forged,
      caps: goodCaps(strategy, nowMs),
      nowMs,
      env: {},
    }),
    /evidence.*(digest|artifact|integrity|id)/i,
  );
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
    assert.throws(() => prepareHandoff({ ...base, caps }), new RegExp(key, "i"));
  }
  assert.throws(
    () => prepareHandoff({ ...base, caps: { ...base.caps, chainAllowlist: [] } }),
    /chainAllowlist/i,
  );
  assert.throws(
    () => prepareHandoff({ ...base, caps: { ...base.caps, assetAllowlist: [] } }),
    /assetAllowlist/i,
  );
  assert.throws(
    () => prepareHandoff({ ...base, caps: { ...base.caps, chainAllowlist: ["ethereum"] } }),
    /hyperliquid|chainAllowlist/i,
  );
  assert.throws(
    () => prepareHandoff({ ...base, caps: { ...base.caps, assetAllowlist: ["ETH"] } }),
    /assetAllowlist|BTC/i,
  );
  assert.throws(
    () => prepareHandoff({ ...base, caps: { ...base.caps, expiresAt: nowMs } }),
    /expiresAt/i,
  );
  assert.throws(
    () => prepareHandoff({ ...base, caps: { ...base.caps, expiresAt: strategy.risk.expiresAt + 1 } }),
    /expiresAt/i,
  );
  assert.throws(
    () =>
      prepareHandoff({
        ...base,
        evidence: goodEvidence(compiled, { strategyHash: "0".repeat(64) }),
      }),
    /strategyHash/i,
  );
  assert.throws(
    () =>
      prepareHandoff({
        ...base,
        evidence: goodEvidence(compiled, { compilerHash: "0".repeat(64) }),
      }),
    /compilerHash/i,
  );
  assert.throws(
    () => prepareHandoff({ ...base, evidence: goodEvidence(compiled, { id: "" }) }),
    /evidence|id/i,
  );
  assert.throws(
    () => prepareHandoff({ ...base, caps: { ...base.caps, killSwitchRequired: false } }),
    /killSwitchRequired/i,
  );
  assert.throws(
    () => prepareHandoff({ ...base, caps: { ...base.caps, perStrategyNotionalUsd: 0 } }),
    /perStrategyNotionalUsd/i,
  );
  assert.throws(
    () => prepareHandoff({ ...base, caps: { ...base.caps, perStrategyNotionalUsd: 5000 } }),
    /perStrategyNotionalUsd|maxNotional/i,
  );
  assert.throws(
    () => prepareHandoff({ ...base, caps: { ...base.caps, maxLeverage: 50 } }),
    /maxLeverage/i,
  );
});

test("public handoff rejects hostile evidence fields and keeps execution flags false", () => {
  const nowMs = 1_800_000_000_000;
  const strategy = baseStrategy();
  const compiled = compileStrategy(strategy);
  assert.throws(
    () => prepareHandoff({
      strategy,
      evidence: {
        ...goodEvidence(compiled),
        liveBroadcast: true,
        signingReady: true,
        broadcastReady: true,
        executionReady: true,
      },
      caps: goodCaps(strategy, nowMs),
      nowMs,
    }),
    /unbound|identity/i,
  );
  const prepared = prepareHandoff({
    strategy,
    evidence: goodEvidence(compiled),
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
      prepareHandoff({
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
