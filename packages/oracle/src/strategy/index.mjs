export {
  STRATEGY_VERSION,
  StrategyValidationError,
  validateStrategy,
  normalizeStrategy,
  canonicalStrategyJson,
  strategyHash,
  applyParameterOverrides,
} from "./schema.mjs";

export { sma, ema, rsi, macd, bollinger, atr } from "./indicators.mjs";

export {
  fetchHyperliquidStrategyBars,
  intervalToMs,
  normalizeHyperliquidCandles,
} from "./history.mjs";

export {
  STRATEGY_COMPILER_HASH,
  STRATEGY_COMPILER_VERSION,
  compileStrategy,
} from "./compiler.mjs";

export { backtestStrategy } from "./backtest.mjs";
export { MAX_OPTIMIZER_TRIALS, optimizeStrategy } from "./optimizer.mjs";
export {
  EVIDENCE_STATUSES,
  assertEvidenceArtifact,
  computeEvidenceArtifactId,
  evaluateEvidence,
} from "./evidence.mjs";
export { StrategyDraftError, draftStrategyFromPrompt } from "./nl-draft.mjs";
export { openShadowStore } from "./shadow-store.mjs";
export { createShadowRunner } from "./shadow-runner.mjs";
export { prepareStrategyLiveHandoff } from "./handoff.mjs";
export { runStrategyOperation } from "./service.mjs";
