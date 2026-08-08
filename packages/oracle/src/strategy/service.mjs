import os from "node:os";
import path from "node:path";
import { assertStrategyRequiredSeries, backtestStrategy } from "./backtest.mjs";
import { compileStrategy } from "./compiler.mjs";
import { evaluateEvidence } from "./evidence.mjs";
import { prepareStrategyLiveHandoff } from "./handoff.mjs";
import { fetchHyperliquidStrategyBars } from "./history.mjs";
import { draftStrategyFromPrompt } from "./nl-draft.mjs";
import { optimizeStrategy } from "./optimizer.mjs";
import { createShadowRunner, shadowStateHash } from "./shadow-runner.mjs";

const SECRET_KEYS = [
  "privatekey",
  "secretkey",
  "seed",
  "mnemonic",
  "passphrase",
  "password",
  "keystore",
  "keymaterial",
  "apikey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "credential",
  "bearer",
  "signature",
  "authorization",
  "xprv",
  "xpriv",
  "wif",
];

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoSecrets(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecrets(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.some((token) => normalizedKey(key).includes(token))) {
      throw new Error(`strategy service: secret-like field "${key}" is forbidden`);
    }
    assertNoSecrets(child);
  }
}

function operationInput(input) {
  if (!isPlainObject(input)) throw new TypeError("strategy input must be a plain object");
  assertNoSecrets(input);
  return input;
}

function operationNow(input, context) {
  const value = context.nowMs ?? input.nowMs ?? Date.now();
  if (!Number.isInteger(value)) throw new TypeError("nowMs must be an integer epoch milliseconds");
  return value;
}

async function resolveBars(strategy, input, context, nowMs) {
  if (Array.isArray(input.bars)) return input.bars;
  const fetchBars = context.fetchBars ?? fetchHyperliquidStrategyBars;
  const result = await fetchBars({
    coin: strategy.market.coin,
    interval: strategy.market.interval,
    count: input.count ?? 1500,
    endTime: input.endTime ?? nowMs,
  });
  const bars = Array.isArray(result) ? result : result?.bars;
  if (!Array.isArray(bars)) throw new Error("strategy history provider returned no bars");
  return bars;
}

function backtestOptions(input, nowMs) {
  const supplied = input.backtestOptions ?? {};
  if (!isPlainObject(supplied)) throw new TypeError("backtestOptions must be a plain object");
  return { ...supplied, nowMs };
}

function evidenceOptions(input, strategy, bars, nowMs, overrides = {}) {
  const supplied = input.evidenceOptions ?? {};
  if (!isPlainObject(supplied)) throw new TypeError("evidenceOptions must be a plain object");
  return {
    ...supplied,
    ...overrides,
    strategy,
    bars,
    backtestOptions: backtestOptions(input, nowMs),
  };
}

function defaultStorePath() {
  return path.join(os.homedir(), ".oracle", "strategy-shadow.json");
}

function defaultCaps(strategy, nowMs) {
  return {
    perStrategyNotionalUsd: strategy.risk.maxNotionalUsd,
    maxLeverage: strategy.risk.maxLeverage,
    dailyLossCapUsd:
      strategy.risk.maxNotionalUsd * (strategy.risk.maxDailyLossPct / 100),
    chainAllowlist: ["hyperliquid"],
    assetAllowlist: [strategy.market.coin],
    expiresAt: Math.min(strategy.risk.expiresAt, nowMs + 86_400_000),
    killSwitchRequired: true,
  };
}

export async function runStrategyOperation(operation, rawInput = {}, context = {}) {
  const input = operationInput(rawInput);
  const nowMs = operationNow(input, context);

  if (operation === "draft") {
    return { strategy: draftStrategyFromPrompt(input.prompt, { nowMs }) };
  }

  if (operation === "validate") {
    const compiled = compileStrategy(input.strategy);
    if (compiled.strategy.risk.expiresAt <= nowMs) {
      throw new Error("strategy is expired");
    }
    return {
      valid: true,
      strategy: compiled.strategy,
      strategyHash: compiled.strategyHash,
      compilerHash: compiled.compilerHash,
      compilerVersion: compiled.compilerVersion,
      requiredSeries: compiled.requiredSeries,
    };
  }

  if (operation === "backtest" || operation === "evidence") {
    const compiled = compileStrategy(input.strategy);
    const bars = await resolveBars(compiled.strategy, input, context, nowMs);
    assertStrategyRequiredSeries(compiled, bars);
    const evidence = evaluateEvidence(evidenceOptions(input, compiled.strategy, bars, nowMs));
    if (operation === "evidence") return evidence;
    return {
      backtest: backtestStrategy(compiled.strategy, bars, backtestOptions(input, nowMs)),
      evidence,
    };
  }

  if (operation === "optimize") {
    const compiled = compileStrategy(input.strategy);
    const bars = await resolveBars(compiled.strategy, input, context, nowMs);
    assertStrategyRequiredSeries(compiled, bars);
    const operationTrainFraction = input.trainFraction;
    const evidenceTrainFraction = input.evidenceOptions?.trainFraction;
    if (
      operationTrainFraction != null &&
      evidenceTrainFraction != null &&
      operationTrainFraction !== evidenceTrainFraction
    ) {
      throw new TypeError("conflicting trainFraction controls are forbidden");
    }
    const trainFraction = operationTrainFraction ?? evidenceTrainFraction ?? 0.7;
    if (typeof trainFraction !== "number" || trainFraction <= 0 || trainFraction >= 1) {
      throw new TypeError("trainFraction must be in (0,1)");
    }
    const trainBars = bars.slice(0, Math.floor(bars.length * trainFraction));
    const supplied = input.options ?? {};
    if (!isPlainObject(supplied)) throw new TypeError("options must be a plain object");
    const optimization = optimizeStrategy(compiled.strategy, trainBars, {
      ...supplied,
      ...(input.maxTrials == null ? {} : { maxTrials: input.maxTrials }),
      backtestOptions: backtestOptions(input, nowMs),
    });
    const strategy = optimization.bestStrategy;
    return {
      strategy,
      optimization,
      evidence: evaluateEvidence(
        evidenceOptions(input, strategy, bars, nowMs, { trainFraction }),
      ),
    };
  }

  if (operation === "shadow") {
    const runner = createShadowRunner({
      storePath: context.storePath ?? defaultStorePath(),
      clock: () => nowMs,
    });
    const action = input.action;
    if (action === "start") {
      return await runner.start({
        strategy: input.strategy,
        evidenceId: input.evidenceId ?? input.evidence?.id ?? null,
      });
    }
    if (action === "list") return await runner.list();
    if (action === "get") return await runner.get(input.id);
    if (action === "stop") return await runner.stop(input.id);
    if (action === "step") {
      const record = await runner.get(input.id);
      if (!record) throw new Error(`shadow runner not found: ${input.id}`);
      const bars = await resolveBars(record.strategy, input, context, nowMs);
      assertStrategyRequiredSeries(compileStrategy(record.strategy), bars);
      return await runner.step(input.id, bars, input.stepOptions ?? {});
    }
    throw new Error(`unknown shadow action: ${action}`);
  }

  if (operation === "prepare") {
    const compiled = compileStrategy(input.strategy);
    if (typeof input.shadowId !== "string" || !input.shadowId) {
      throw new Error("strategy prepare requires a matching shadow runner id");
    }
    const runner = createShadowRunner({
      storePath: context.storePath ?? defaultStorePath(),
      clock: () => nowMs,
    });
    const shadow = await runner.get(input.shadowId);
    if (!shadow) throw new Error("strategy prepare shadow runner not found");
    if (shadow.status !== "running") {
      throw new Error("strategy prepare requires an active shadow runner");
    }
    if (!Number.isFinite(shadow.cursor)) {
      throw new Error("strategy prepare requires a stepped shadow runner");
    }
    if (
      shadow.strategyHash !== compiled.strategyHash ||
      shadow.compilerHash !== compiled.compilerHash
    ) {
      throw new Error("strategy prepare shadow runner does not match strategy artifacts");
    }
    if (shadow.evidenceId !== input.evidence?.id) {
      throw new Error("strategy prepare shadow runner does not match evidence artifact");
    }
    const caps = input.caps ?? defaultCaps(compiled.strategy, nowMs);
    return prepareStrategyLiveHandoff({
      strategy: compiled.strategy,
      evidence: input.evidence,
      shadow: {
        id: shadow.id,
        stateHash: shadowStateHash(shadow),
        status: shadow.status,
        cursor: shadow.cursor,
        updatedAt: shadow.updatedAt,
      },
      caps,
      nowMs,
      env: context.env ?? process.env,
    });
  }

  throw new Error(`unknown strategy operation: ${operation}`);
}
