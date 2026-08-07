import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StrategyDraftError,
  draftStrategyFromPrompt,
} from "../src/strategy/nl-draft.mjs";
import { validateStrategy, strategyHash } from "../src/strategy/schema.mjs";

const NOW = 1_700_000_000_000;

test("StrategyDraftError is an Error subclass", () => {
  const err = new StrategyDraftError("x");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof StrategyDraftError);
  assert.equal(err.name, "StrategyDraftError");
});

test("EMA cross prompt drafts valid strategy", () => {
  const s = draftStrategyFromPrompt(
    "long BTC when EMA 9 crosses above EMA 21 on 15m, exit on reverse, stop loss 2%, take profit 4%, leverage 2, position size 5%, max notional 100",
    { nowMs: NOW },
  );
  const v = validateStrategy(s, { nowMs: NOW });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(s.market.coin, "BTC");
  assert.equal(s.market.interval, "15m");
  assert.equal(s.venue, "hyperliquid");
  assert.equal(s.risk.maxLeverage, 2);
  assert.equal(s.risk.positionSizePct, 5);
  assert.equal(s.risk.maxNotionalUsd, 100);
  assert.equal(s.risk.stopLossPct, 2);
  assert.equal(s.risk.takeProfitPct, 4);
  assert.equal(s.risk.cooldownBars, 1);
  assert.equal(s.risk.maxDailyLossPct, 3);
  assert.ok(s.rules.entryLong);
  assert.ok(s.rules.exitLong);
  assert.equal(s.rules.entryShort, null);
});

test("EMA cross below drafts short entry", () => {
  const s = draftStrategyFromPrompt(
    "short ETH when EMA 5 crosses below EMA 20 on 5m",
    { nowMs: NOW },
  );
  assert.equal(validateStrategy(s, { nowMs: NOW }).ok, true);
  assert.equal(s.market.coin, "ETH");
  assert.equal(s.market.interval, "5m");
  assert.ok(s.rules.entryShort);
  assert.equal(s.rules.entryLong, null);
});

test("RSI prompt drafts valid long or short", () => {
  const longS = draftStrategyFromPrompt("long SOL when RSI 14 below 30 on 1h", {
    nowMs: NOW,
  });
  assert.equal(validateStrategy(longS, { nowMs: NOW }).ok, true);
  assert.equal(longS.market.coin, "SOL");
  assert.equal(longS.market.interval, "1h");
  assert.ok(longS.rules.entryLong);

  const shortS = draftStrategyFromPrompt("short HYPE when RSI 7 above 70", {
    nowMs: NOW,
  });
  assert.equal(validateStrategy(shortS, { nowMs: NOW }).ok, true);
  assert.equal(shortS.market.coin, "HYPE");
  assert.equal(shortS.market.interval, "15m"); // default
  assert.ok(shortS.rules.entryShort);
});

test("funding rate prompt drafts valid strategy", () => {
  const s = draftStrategyFromPrompt(
    "short BTC when funding rate above 0.01 on 1h",
    { nowMs: NOW },
  );
  assert.equal(validateStrategy(s, { nowMs: NOW }).ok, true);
  assert.ok(s.nodes.some((n) => n.type === "input" && n.field === "fundingRate"));
  assert.ok(s.rules.entryShort);

  const pct = draftStrategyFromPrompt(
    "long ETH when funding rate below -0.05% on 4h",
    { nowMs: NOW },
  );
  assert.equal(validateStrategy(pct, { nowMs: NOW }).ok, true);
  assert.ok(pct.rules.entryLong);
});

test("recognizes explicit uppercase coin token max 12 chars", () => {
  const s = draftStrategyFromPrompt(
    "long DOGE when RSI 14 below 25 on 30m",
    { nowMs: NOW },
  );
  assert.equal(s.market.coin, "DOGE");
});

test("optional risk overrides and conservative defaults", () => {
  const s = draftStrategyFromPrompt("long BTC when RSI 14 below 30", {
    nowMs: NOW,
  });
  assert.equal(s.risk.maxLeverage, 1);
  assert.equal(s.risk.positionSizePct, 5);
  assert.equal(s.risk.maxNotionalUsd, 100);
  assert.equal(s.risk.stopLossPct, 2);
  assert.equal(s.risk.takeProfitPct, 4);
  assert.equal(s.risk.cooldownBars, 1);
  assert.equal(s.risk.maxDailyLossPct, 3);
  assert.equal(s.risk.expiresAt, NOW + 86_400_000);
});

test("expiresInMs bounded 1h..30d and nowMs required", () => {
  assert.throws(() => draftStrategyFromPrompt("long BTC when RSI 14 below 30"), /nowMs/i);
  assert.throws(
    () =>
      draftStrategyFromPrompt("long BTC when RSI 14 below 30", {
        nowMs: NOW,
        expiresInMs: 1000,
      }),
    /expires/i,
  );
  assert.throws(
    () =>
      draftStrategyFromPrompt("long BTC when RSI 14 below 30", {
        nowMs: NOW,
        expiresInMs: 40 * 86_400_000,
      }),
    /expires/i,
  );
  const s = draftStrategyFromPrompt("long BTC when RSI 14 below 30", {
    nowMs: NOW,
    expiresInMs: 3_600_000,
  });
  assert.equal(s.risk.expiresAt, NOW + 3_600_000);
});

test("strategy id deterministic from normalized prompt plus hash suffix", () => {
  const a = draftStrategyFromPrompt("long BTC when RSI 14 below 30 on 15m", {
    nowMs: NOW,
  });
  const b = draftStrategyFromPrompt("long BTC when RSI 14 below 30 on 15m", {
    nowMs: NOW,
  });
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  // different prompt -> different id
  const c = draftStrategyFromPrompt("long ETH when RSI 14 below 30 on 15m", {
    nowMs: NOW,
  });
  assert.notEqual(a.id, c.id);
  // hash of strategy body still stable
  assert.equal(strategyHash(a), strategyHash(b));
});

test("parser rejects unsupported prompts with grammar summary", () => {
  assert.throws(
    () => draftStrategyFromPrompt("buy the dip with AI magic", { nowMs: NOW }),
    (err) => {
      assert.ok(err instanceof StrategyDraftError);
      assert.match(String(err.message), /EMA|RSI|funding/i);
      return true;
    },
  );
  assert.throws(
    () =>
      draftStrategyFromPrompt("long BTC when MACD histogram flips", {
        nowMs: NOW,
      }),
    StrategyDraftError,
  );
});

test("parser rejects secret-bearing prompts", () => {
  for (const p of [
    "long BTC when RSI 14 below 30 mnemonic word word",
    "long BTC RSI 14 below 30 private key abc",
    "long BTC RSI apiKey=sk-123",
    "long BTC seed phrase hello",
  ]) {
    assert.throws(
      () => draftStrategyFromPrompt(p, { nowMs: NOW }),
      StrategyDraftError,
      p,
    );
  }
});

test("prompt length max 1000", () => {
  const long = `long BTC when RSI 14 below 30 ${"x".repeat(1000)}`;
  assert.throws(() => draftStrategyFromPrompt(long, { nowMs: NOW }), /length|1000/i);
});

test("byte stable for identical inputs", () => {
  const p = "long BTC when EMA 8 crosses above EMA 21 on 1h, reverse exit, leverage 3";
  const a = draftStrategyFromPrompt(p, { nowMs: NOW });
  const b = draftStrategyFromPrompt(p, { nowMs: NOW });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
