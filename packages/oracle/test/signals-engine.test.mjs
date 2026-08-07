import assert from "node:assert/strict";
import test from "node:test";

import { createSignalsEngine, scoreSignals } from "../src/signals/index.mjs";

test("smart-wallet repeat buys create transparent, ranked cold signals", () => {
  const signals = scoreSignals([
    { id: "casual", type: "wallet", repeatBuys: 1, walletWinRate: 0.51 },
    { id: "smart", type: "wallet", repeatBuys: 5, walletWinRate: 0.8 },
  ]);

  assert.equal(signals[0].id, "smart");
  assert.ok(signals[0].score > signals[1].score);
  assert.ok(signals[0].contributions.some(({ feature, value }) => feature === "repeat_buys" && value > 0));
  assert.equal(signals[0].executionAllowed, false);
  assert.ok(signals[0].flags.includes("NO_HOT_EXECUTION"));
});

test("new pools are risk penalized and explicitly no-trade", () => {
  const [signal] = scoreSignals([{ id: "pool-1", type: "pool", ageHours: 2, liquidityUsd: 20_000, liquidityLocked: false }]);

  assert.ok(signal.score < 0.5);
  assert.equal(signal.noTrade, true);
  assert.ok(signal.flags.includes("NEW_POOL_RISK"));
});

test("negative shadow markout lowers score and confidence", () => {
  const events = [{ id: "wallet-1", type: "wallet", repeatBuys: 5, walletWinRate: 0.8 }];
  const baseline = scoreSignals(events)[0];
  const marked = scoreSignals(events, [{ signalId: "wallet-1", return: -0.5 }])[0];

  assert.ok(marked.score < baseline.score);
  assert.ok(marked.confidence < baseline.confidence);
  assert.ok(marked.flags.includes("NEGATIVE_MARKOUT"));
  assert.ok(marked.contributions.some(({ feature }) => feature === "shadow_markout"));
});

test("missing observations become low confidence, never fabricated edge", () => {
  const engine = createSignalsEngine();
  const [signal] = engine.score([{ id: "unknown-floor", type: "nft_floor" }]);

  assert.equal(signal.score, 0.5);
  assert.equal(signal.coverage, 0);
  assert.equal(signal.confidence, 0);
  assert.deepEqual(signal.contributions, []);
  assert.equal(signal.noTrade, true);
  assert.ok(signal.flags.includes("LOW_COVERAGE"));
});

test("supports NFT floors, HL flow, and prediction-market mispricing", () => {
  const signals = scoreSignals([
    { id: "nft", type: "nft_floor", floorChangePct: 0.2, sales: 25 },
    { id: "hl", type: "hl_flow", flowImbalance: 0.6, fundingRate: 0.001 },
    { id: "prediction", type: "prediction_market", marketProbability: 0.35, fairProbability: 0.65, liquidityUsd: 100_000 },
  ]);

  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal.coverage === 1));
  assert.ok(signals.find(({ id }) => id === "prediction").score > 0.5);
});
