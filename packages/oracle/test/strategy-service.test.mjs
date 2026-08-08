import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileStrategy,
  computeEvidenceArtifactId,
  draftStrategyFromPrompt,
  evaluateEvidence,
  runStrategyOperation,
} from "../src/strategy/index.mjs";

const NOW = 1_800_000_000_000;

function storePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oracle-strategy-service-")), "shadow.json");
}

function bars(count = 80) {
  const out = [];
  for (let index = 0; index < count; index++) {
    const base = 100 + Math.sin(index / 4) * 8 + index * 0.1;
    out.push({
      t: NOW - (count - index) * 900_000,
      o: base,
      h: base + 2,
      l: base - 2,
      c: base + Math.sin(index / 2),
      v: 10_000,
      fundingRate: 0.00001,
    });
  }
  return out;
}

function strategy() {
  return draftStrategyFromPrompt("long BTC when EMA 3 crosses above EMA 8", { nowMs: NOW });
}

const context = () => ({ nowMs: NOW, storePath: storePath(), env: {} });

function liveEvidence(compiled) {
  const body = {
    status: "pass_live_eligible",
    strategyHash: compiled.strategyHash,
    compilerHash: compiled.compilerHash,
    barsHash: "c".repeat(64),
    split: { trainStartIndex: 0, trainEndIndex: 69, trainBarCount: 70, holdoutStartIndex: 70, holdoutEndIndex: 99, holdoutBarCount: 30, trainFraction: 0.7 },
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
  };
  return { id: computeEvidenceArtifactId(body), ...body };
}

test("service drafts validates and compiles deterministic strategies", async () => {
  const drafted = await runStrategyOperation("draft", { prompt: "long BTC when EMA 3 crosses above EMA 8" }, context());
  assert.equal(drafted.strategy.venue, "hyperliquid");
  const validated = await runStrategyOperation("validate", { strategy: drafted.strategy }, context());
  assert.equal(validated.valid, true);
  assert.equal(validated.strategyHash, compileStrategy(drafted.strategy).strategyHash);
});

test("service backtest returns replay and bound evidence", async () => {
  const result = await runStrategyOperation("backtest", { strategy: strategy(), bars: bars() }, context());
  assert.ok(result.backtest.metrics);
  assert.equal(result.evidence.strategyHash, result.backtest.strategyHash);
  assert.equal(result.evidence.compilerHash, result.backtest.compilerHash);
});

test("service optimize evaluates the selected strategy on full evidence bars", async () => {
  const result = await runStrategyOperation("optimize", { strategy: strategy(), bars: bars(), options: { maxTrials: 4 } }, context());
  assert.ok(result.optimization.bestStrategy);
  assert.equal(result.strategy.id, result.optimization.bestStrategy.id);
  assert.equal(result.evidence.strategyHash, compileStrategy(result.strategy).strategyHash);
});

test("service optimize rejects conflicting train and evidence split controls", async () => {
  await assert.rejects(
    () => runStrategyOperation("optimize", {
      strategy: strategy(),
      bars: bars(100),
      trainFraction: 0.8,
      evidenceOptions: { trainFraction: 0.2 },
      options: { maxTrials: 4 },
    }, context()),
    /trainFraction.*conflict|conflicting.*trainFraction/i,
  );
});

test("service shadow start step list and stop persist without custody fields", async () => {
  const ctx = context();
  const started = await runStrategyOperation("shadow", { action: "start", strategy: strategy() }, ctx);
  const stepped = await runStrategyOperation("shadow", { action: "step", id: started.id, bars: bars(20) }, ctx);
  assert.equal(stepped.id, started.id);
  const listed = await runStrategyOperation("shadow", { action: "list" }, ctx);
  assert.equal(listed.length, 1);
  const stopped = await runStrategyOperation("shadow", { action: "stop", id: started.id }, ctx);
  assert.equal(stopped.status, "stopped");
});

test("service prepare derives narrowing caps and never marks execution ready", async () => {
  const s = strategy();
  const compiled = compileStrategy(s);
  const evidence = liveEvidence(compiled);
  const ctx = context();
  const shadow = await runStrategyOperation("shadow", { action: "start", strategy: s, evidenceId: evidence.id }, ctx);
  await runStrategyOperation("shadow", { action: "step", id: shadow.id, bars: bars(20) }, ctx);
  const prepared = await runStrategyOperation("prepare", { strategy: s, evidence, shadowId: shadow.id }, ctx);
  assert.equal(prepared.arming.liveBroadcast, false);
  assert.equal(prepared.signingReady, false);
  assert.equal(prepared.broadcastReady, false);
  assert.equal(prepared.executionReady, false);
  assert.deepEqual(prepared.arming.caps.assetAllowlist, [s.market.coin]);
  assert.equal(prepared.shadow.id, shadow.id);
  assert.match(prepared.shadow.stateHash, /^[0-9a-f]{64}$/);

  const advancedBars = bars(20);
  advancedBars.push({
    ...advancedBars.at(-1),
    t: NOW,
    o: advancedBars.at(-1).c,
    h: advancedBars.at(-1).c + 2,
    l: advancedBars.at(-1).c - 2,
  });
  await runStrategyOperation("shadow", {
    action: "step",
    id: shadow.id,
    bars: advancedBars,
  }, ctx);
  const advanced = await runStrategyOperation(
    "prepare",
    { strategy: s, evidence, shadowId: shadow.id },
    ctx,
  );
  assert.notEqual(advanced.shadow.stateHash, prepared.shadow.stateHash);
});

test("service prepare fails closed without a matching stepped shadow runner", async () => {
  const s = strategy();
  const evidence = liveEvidence(compileStrategy(s));
  await assert.rejects(
    () => runStrategyOperation("prepare", { strategy: s, evidence }, context()),
    /shadow/i,
  );
});

test("service fails closed when a required external series is absent", async () => {
  const s = JSON.parse(JSON.stringify(strategy()));
  s.nodes = [
    { id: "oi", type: "input", field: "openInterest" },
    { id: "threshold", type: "constant", value: 1 },
    { id: "signal", type: "compare", op: "gt", left: "oi", right: "threshold" },
  ];
  s.rules = { entryLong: "signal", entryShort: null, exitLong: null, exitShort: null };
  const withoutOi = bars().map(({ fundingRate, ...bar }) => ({ ...bar, fundingRate }));
  await assert.rejects(
    () => runStrategyOperation("backtest", { strategy: s, bars: withoutOi }, context()),
    /required series.*openInterest/i,
  );
});

test("service fetches bars through injection and rejects unknown or secret-bearing input", async () => {
  let calls = 0;
  const ctx = {
    ...context(),
    fetchBars: async () => {
      calls += 1;
      return bars();
    },
  };
  await runStrategyOperation("backtest", { strategy: strategy() }, ctx);
  assert.equal(calls, 1);
  await assert.rejects(() => runStrategyOperation("wat", {}, ctx), /unknown strategy operation/i);
  await assert.rejects(
    () => runStrategyOperation("validate", { strategy: strategy(), privateKey: "never-echo" }, ctx),
    (error) => /secret-like/i.test(error.message) && !error.message.includes("never-echo"),
  );
  await assert.rejects(
    () => runStrategyOperation("validate", { strategy: strategy(), userPrivateKeyBackup: "never-echo" }, ctx),
    (error) => /secret-like/i.test(error.message) && !error.message.includes("never-echo"),
  );
});
