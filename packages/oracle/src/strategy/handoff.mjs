// Prepare-only local operator handoff for a live-eligible strategy.
// Never signs, broadcasts, or evaluates execution enable flags.

import { compileStrategy, STRATEGY_COMPILER_VERSION } from "./compiler.mjs";
import { normalizeStrategy } from "./schema.mjs";
import { stampPrepared } from "../prepare-envelope.mjs";

const SECRET_KEYS = new Set([
  "privatekey",
  "secretkey",
  "seed",
  "mnemonic",
  "password",
  "credential",
  "bearer",
  "signature",
]);

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoSecrets(value, at = "value") {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, `${at}[${i}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const norm = normalizeKey(key);
    if (SECRET_KEYS.has(norm)) {
      throw new Error(`handoff: forbidden secret-like field at ${at}.${key}`);
    }
    assertNoSecrets(child, `${at}.${key}`);
  }
}

function isPositiveNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Build a prepare-only envelope for local operator handoff.
 * Despite the name, this never arms live broadcast.
 */
export function prepareStrategyLiveHandoff({
  strategy,
  evidence,
  caps,
  nowMs = Date.now(),
  env = process.env,
} = {}) {
  assertNoSecrets({ strategy, evidence, caps }, "handoff");

  if (!isPlainObject(strategy)) throw new Error("handoff: strategy required");
  if (!isPlainObject(evidence)) throw new Error("handoff: evidence required");
  if (!isPlainObject(caps)) throw new Error("handoff: caps required");

  // Validate with nowMs then compile.
  const normalized = normalizeStrategy(strategy, { nowMs });
  const compiled = compileStrategy(normalized);

  // Evidence
  if (typeof evidence.id !== "string" || evidence.id.length === 0) {
    throw new Error("handoff: evidence.id must be a non-empty string");
  }
  if (evidence.status !== "pass_live_eligible") {
    throw new Error("handoff: evidence.status must be pass_live_eligible");
  }
  if (evidence.strategyHash !== compiled.strategyHash) {
    throw new Error("handoff: evidence.strategyHash mismatch");
  }
  if (evidence.compilerHash !== compiled.compilerHash) {
    throw new Error("handoff: evidence.compilerHash mismatch");
  }

  // Caps: required fields, no widening
  const required = [
    "perStrategyNotionalUsd",
    "maxLeverage",
    "dailyLossCapUsd",
    "chainAllowlist",
    "assetAllowlist",
    "expiresAt",
    "killSwitchRequired",
  ];
  for (const key of required) {
    if (!(key in caps) || caps[key] == null) {
      throw new Error(`handoff: caps.${key} required`);
    }
  }

  if (!isPositiveNumber(caps.perStrategyNotionalUsd)) {
    throw new Error("handoff: caps.perStrategyNotionalUsd must be positive");
  }
  if (caps.perStrategyNotionalUsd > compiled.strategy.risk.maxNotionalUsd) {
    throw new Error("handoff: caps.perStrategyNotionalUsd exceeds strategy.risk.maxNotionalUsd");
  }

  if (!isPositiveNumber(caps.maxLeverage)) {
    throw new Error("handoff: caps.maxLeverage must be positive");
  }
  if (caps.maxLeverage > compiled.strategy.risk.maxLeverage) {
    throw new Error("handoff: caps.maxLeverage exceeds strategy.risk.maxLeverage");
  }

  if (!isPositiveNumber(caps.dailyLossCapUsd)) {
    throw new Error("handoff: caps.dailyLossCapUsd must be positive");
  }

  if (!Array.isArray(caps.chainAllowlist) || caps.chainAllowlist.length === 0) {
    throw new Error("handoff: caps.chainAllowlist must be a non-empty array");
  }
  if (!caps.chainAllowlist.every((c) => c === "hyperliquid")) {
    throw new Error("handoff: caps.chainAllowlist must include only hyperliquid");
  }
  if (!caps.chainAllowlist.includes("hyperliquid")) {
    throw new Error("handoff: caps.chainAllowlist must include hyperliquid");
  }

  if (!Array.isArray(caps.assetAllowlist) || caps.assetAllowlist.length === 0) {
    throw new Error("handoff: caps.assetAllowlist must be a non-empty array");
  }
  if (!caps.assetAllowlist.includes(compiled.strategy.market.coin)) {
    throw new Error("handoff: caps.assetAllowlist must include strategy market coin");
  }

  if (!Number.isInteger(caps.expiresAt) || !(caps.expiresAt > nowMs)) {
    throw new Error("handoff: caps.expiresAt must be an integer > nowMs");
  }
  if (caps.expiresAt > compiled.strategy.risk.expiresAt) {
    throw new Error("handoff: caps.expiresAt exceeds strategy.risk.expiresAt");
  }

  if (caps.killSwitchRequired !== true) {
    throw new Error("handoff: caps.killSwitchRequired must be exactly true");
  }

  const armingCaps = {
    perStrategyNotionalUsd: caps.perStrategyNotionalUsd,
    maxLeverage: caps.maxLeverage,
    dailyLossCapUsd: caps.dailyLossCapUsd,
    chainAllowlist: [...caps.chainAllowlist],
    assetAllowlist: [...caps.assetAllowlist],
    expiresAt: caps.expiresAt,
    killSwitchRequired: true,
  };

  const payload = {
    strategyHash: compiled.strategyHash,
    compilerHash: compiled.compilerHash,
    evidence: {
      id: evidence.id,
      status: "pass_live_eligible",
      strategyHash: compiled.strategyHash,
      compilerHash: compiled.compilerHash,
    },
    compiled: {
      strategyHash: compiled.strategyHash,
      compilerHash: compiled.compilerHash,
      compilerVersion: STRATEGY_COMPILER_VERSION,
      venue: "hyperliquid",
      market: {
        coin: compiled.strategy.market.coin,
        interval: compiled.strategy.market.interval,
      },
      risk: { ...compiled.strategy.risk },
      strategy: JSON.parse(JSON.stringify(compiled.strategy)),
    },
    arming: {
      liveBroadcast: false,
      requiresExplicitUserArm: true,
      caps: armingCaps,
    },
    requiresUserSignature: true,
    signingReady: false,
    broadcastReady: false,
    executionReady: false,
  };

  return stampPrepared(payload, {
    provider: "hl-strategy",
    kind: "strategy-live-handoff",
    env,
  });
}
