// Oracle Router risk classifier.
//
// Pure, dependency-free, deterministic. No I/O, no network, no chain reads,
// no imports. The router uses this to LABEL a proposed action's risk tier for
// advisory purposes only -- the label is context for a human or for Oracle
// Control, never an authorization decision. Oracle Control independently
// validates and gates every real action; nothing here grants or implies
// permission to sign, broadcast, or spend.

export const RISK_TIERS = Object.freeze(["low", "medium", "high", "critical"]);

// Kinds the router treats as pure read/advisory work (no custody exposure).
export const READ_ONLY_KINDS = Object.freeze(["read", "quote", "explain", "simulate"]);

// Kinds that describe a draft custody-adjacent action. These are still just
// labels on a proposal -- classifying something as "swap" does not create a
// swap, sign anything, or move funds.
export const CUSTODY_ADJACENT_KINDS = Object.freeze([
  "approval",
  "transfer",
  "swap",
  "order",
  "bridge",
]);

function normalizeKind(kind) {
  const k = String(kind || "").trim().toLowerCase();
  return k || "unknown";
}

// Coarse USD notional bands. Unknown/invalid notional is NOT treated as "low"
// -- callers must not be able to escape risk scoring by omitting a number.
function notionalBand(notionalUsd) {
  if (notionalUsd == null) return null;
  const n = Number(notionalUsd);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 100_000) return 3;
  if (n > 10_000) return 2;
  if (n > 1_000) return 1;
  return 0;
}

function tierFromScore(score) {
  if (score >= 7) return "critical";
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

/**
 * Classify the risk tier of a proposed action. Pure function: same input
 * always produces the same output, and calling it has zero side effects.
 *
 * @param {object} [input]
 * @param {string} [input.kind]               "read" | "quote" | "explain" | "simulate" |
 *                                             "approval" | "transfer" | "swap" | "order" |
 *                                             "bridge" | any other string (treated conservatively)
 * @param {number} [input.notionalUsd]         approximate USD notional, if known
 * @param {boolean} [input.destinationKnown]   true if destination is a reviewed/allowlisted venue
 * @param {boolean} [input.unlimitedApproval]  true if the action requests an unbounded/MaxUint256-style approval
 * @param {boolean} [input.crossChain]         true if the action spans chains (bridge-like)
 * @returns {{ tier: "low"|"medium"|"high"|"critical", score: number, reasons: readonly string[] }}
 */
export function classifyRisk(input = {}) {
  const kind = normalizeKind(input?.kind);
  const reasons = [];
  let score = 0;

  const isReadOnly = READ_ONLY_KINDS.includes(kind);
  const isCustodyAdjacent = CUSTODY_ADJACENT_KINDS.includes(kind);

  if (isReadOnly) {
    reasons.push(`kind "${kind}" is read/advisory-only`);
  } else if (isCustodyAdjacent) {
    score += 2;
    reasons.push(`kind "${kind}" is custody-adjacent (+2)`);
  } else {
    score += 3;
    reasons.push(`kind "${kind}" is unrecognized; treated conservatively (+3)`);
  }

  const band = notionalBand(input?.notionalUsd);
  if (band != null && band > 0) {
    score += band;
    reasons.push(`notional band ${band} (+${band})`);
  } else if (band == null && !isReadOnly) {
    score += 1;
    reasons.push("notional unknown for a non-read action (+1)");
  }

  if (input?.unlimitedApproval) {
    score += 3;
    reasons.push("unlimited/unbounded approval requested (+3)");
  }

  if (input?.destinationKnown === false) {
    score += 2;
    reasons.push("destination not a reviewed/allowlisted venue (+2)");
  }

  if (input?.crossChain) {
    score += 1;
    reasons.push("cross-chain action (+1)");
  }

  return Object.freeze({
    tier: tierFromScore(score),
    score,
    reasons: Object.freeze(reasons),
  });
}

export function isReadOnlyKind(kind) {
  return READ_ONLY_KINDS.includes(normalizeKind(kind));
}

export function isCustodyAdjacentKind(kind) {
  return CUSTODY_ADJACENT_KINDS.includes(normalizeKind(kind));
}
