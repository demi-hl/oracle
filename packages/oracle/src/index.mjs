// Oracle public package root.
//
// Curated exports only: data/read plane, scanner/chain registration, routing,
// policy schema, and scope constants.
//
// Key-material and execution modules are deliberately absent from every
// public package entrypoint, so importing the package cannot hand a caller a
// signer.

export {
  stampPrepared,
  assertPreparedEnvelope,
  computePrepareHash,
  computePrepareMac,
  resolvePrepareMaxAgeMs,
  PREPARE_VERSION,
  PREPARE_MAX_AGE_MS,
  PREPARE_HARD_MAX_AGE_MS,
} from "./prepare-envelope.mjs";
export { data, dataCall, dataHealth, dataCatalog } from "./data/desk-data.mjs";
export { registerProvider, getProvider, listProviders } from "./data/catalog.mjs";

export { CHAINS, chainById, registerChain, rpcUrlFor, isSupportedChain } from "./chains.mjs";

export {
  SCANNER_CAPABILITIES,
  EVIDENCE,
  RISK,
  validateScanner,
  createScanner,
  registerScanner,
  getScanner,
  listScanners,
  scannerCoverage,
  CHAIN_CONFIGS,
  registerBuiltinScanners,
  registerCustomChain,
} from "./scanner/index.mjs";

export { bestSwapRoute, bestBridgeRoute, QUALITY } from "./router/index.mjs";
export {
  bestEquityRoute,
  equityVenues,
  prepareEquityRoute,
  collectEquityQuotes,
  toJsonSafe as equityToJsonSafe,
} from "./equities/index.mjs";
export {
  normalizeRfqIntent,
  normalizeFirmQuote,
  hashRfqIntent,
  hashFirmQuote,
} from "./rfq/intent.mjs";
export { sourceCandidates, executeRfqCandidates, rankRfqQuotes, requestRfqQuotes } from "./rfq/sources.mjs";
export { validateNftMintGasWar, assertNftMintGasWar, NftGasWarLimitError } from "./nft-gas-war-guard.mjs";
export { simulateSell, assertSellable, SELL_SIM } from "./sell-simulation.mjs";
export { capabilityStatus, assertCapability, autonomousTradingEnabled, posture } from "./capability-posture.mjs";
export {
  ACTION_MODES,
  actionModeForVerb,
  assertActionRecord,
  createActionRecord,
  isActiveAlert,
  isActiveExecution,
  migrateLegacyWatchRecord,
} from "./action-semantics.mjs";

export {
  GRANT_VERSION,
  normalizeGrant,
  validateGrant,
  canonicalizeGrant,
  grantId,
  GrantValidationError,
} from "./public-control/policy-schema.mjs";

export {
  ALLOWED_SCOPES,
  EXECUTE_SCOPE,
  BUILD_SCOPE,
  DEFAULT_SCOPES,
  normalizeScopes,
} from "./scopes.mjs";

export { emitHarnessConfigs, createHarnessConfigs } from "./onboarding/harness-configs.mjs";
export {
  ACTION_RECEIPT_VERSION,
  ActionReceiptSecretError,
  assertNoReceiptSecrets,
  canonicalReceiptJson,
  computeReceiptId,
  normalizeActionReceipt,
  createActionReceipt,
  summarizeActionReceipt,
  formatActionReceipt,
} from "./action-receipts.mjs";
export { DEFAULT_RISK_THRESHOLDS, summarizePortfolioRisk, portfolioRiskSummary } from "./portfolio-risk.mjs";
export {
  WATCH_CATEGORIES,
  defaultPreferences,
  subscribe,
  unsubscribe,
  createWatch,
  evaluateAlert,
  shouldDeliverAlert,
} from "./watch-preferences.mjs";
export { SIGNAL_TYPES, scoreSignals, createSignalsEngine } from "./signals/index.mjs";
