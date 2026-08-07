// Oracle Control — provider-neutral account-abstraction session-key model.
//
// This is a design spike (Slice B / Phase 2 of the Oracle public release plan,
// see artifacts/oracle-public-plan.md and docs/public-self-custody-aa.md).
// It defines the SHAPE of a public self-custody session-key grant and the
// deterministic policy checks that decide whether a proposed action is
// authorized by that grant — independent of which account-abstraction stack
// (Safe, Kernel/ZeroDev, Biconomy/Nexus, permissionless/viem) eventually
// enforces it on-chain.
//
// Hard boundaries for this file:
//   - No wallet/AA SDK imports. No RPC calls. No live chain integration.
//   - No import from the private executor stack (get-signer.mjs, keystore.mjs,
//     exec-policy.mjs, local-signer/*, oracle-env.mjs, adapters/*). This model
//     must stand alone so it can never be wired to a private operator wallet.
//   - Deterministic, pure functions only — same input always produces the
//     same session id and the same authorization verdict.
//   - `owner` (the user's main wallet / smart-account) never signs a
//     transaction here. This module only decides whether an already-proposed
//     action fits inside an already-granted, bounded session.
//
// Terminology:
//   grant   — the bounded permission the owner signed (chain, actions,
//             targets, value/gas caps, expiry). Provider-neutral; a real
//             integration maps this onto a Safe allowance module, a ZeroDev
//             session-key validator, a Biconomy Nexus session module, or a
//             permissionless/viem session account.
//   agent   — the session key address the grant authorizes to act. Never the
//             owner's main key.
//   request — a single proposed action (action id, target, value, gas) that
//             is checked against a grant before anything is prepared/signed.

import { createHash } from "node:crypto";
import { exactBigInt } from "../exact-integer.mjs";
import { isWindowOpen } from "../fresh-window.mjs";

/** Account-abstraction stacks this model is written to be portable across.
 *  Purely descriptive — no SDK behavior is implied or imported here. */
export const PROVIDERS = Object.freeze({
  SAFE: "safe",
  KERNEL_ZERODEV: "kernel-zerodev",
  BICONOMY_NEXUS: "biconomy-nexus",
  PERMISSIONLESS_VIEM: "permissionless-viem",
});

export const PROVIDER_IDS = Object.freeze(Object.values(PROVIDERS));

/** Session lifecycle states returned by sessionStatus(). */
export const SESSION_STATUS = Object.freeze({
  ACTIVE: "active",
  EXPIRED: "expired",
  REVOKED: "revoked",
});

export const MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Action-id prefixes that never move funds or touch a target contract and
 *  therefore never require a non-empty target allowlist. Matches the "empty
 *  target allowlist only allowed for read/simulate scopes" rule in the Oracle
 *  public policy schema (artifacts/oracle-public-plan.md Phase 1). */
const READ_ONLY_ACTION_PREFIXES = ["read:", "simulate:"];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

function isReadOnlyAction(action) {
  const a = String(action || "");
  return READ_ONLY_ACTION_PREFIXES.some((p) => a.startsWith(p));
}

function fail(message) {
  throw new Error(`session: ${message}`);
}

function normalAddress(value, label) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!ADDRESS_RE.test(text)) fail(`${label} must be a 0x-prefixed 20-byte address`);
  return text;
}

function normalActionId(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) fail("action ids must be non-empty strings");
  if (text.length > 128) fail("action id too long");
  return text;
}

function normalPositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) fail(`${label} must be a positive integer`);
  return n;
}

function normalBigString(value, label, { allowZero = true } = {}) {
  if (value == null || value === "") return "0";
  // Wei caps bound delegated spend. An unsafe JS number rounds UP here and
  // stores a looser cap than the owner wrote, so refuse rather than coerce.
  let n;
  try {
    n = exactBigInt(value, label);
  } catch (e) {
    fail(e.message);
  }
  if (n < 0n) fail(`${label} must not be negative`);
  if (!allowZero && n === 0n) fail(`${label} must be greater than zero`);
  return n.toString();
}

/** Deterministic JSON: object keys sorted recursively, matching the
 *  canonicalJson convention already used by audit-log.mjs / vault-attestation.mjs
 *  so the same fields hash identically everywhere. Self-contained here on
 *  purpose (no cross-file import) to keep this design-spike file standalone. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

/**
 * Deterministic session id: sha256 over the canonical JSON of the grant's
 * identity fields, prefixed 0x. Two grants with identical owner/agent/chain/
 * actions/targets/caps/expiry/nonce always produce the same id; changing any
 * field (including the ordering-insensitive actions/targets arrays, which are
 * sorted before hashing) changes the id.
 */
export function computeSessionId(fields) {
  const h = createHash("sha256");
  h.update(canonicalJson(fields), "utf8");
  return `0x${h.digest("hex")}`;
}

/**
 * Build and validate a provider-neutral session grant. Throws on any
 * malformed/unsafe input (fail-closed). Returns a deep-frozen record.
 *
 * @param {object} input
 * @param {string} input.provider     one of PROVIDERS (informational; which
 *                                    AA stack is expected to enforce this)
 * @param {string} input.owner        user's main wallet / smart-account address
 * @param {string} input.agent        session key address (must differ from owner)
 * @param {number} input.chainId      positive integer chain id
 * @param {string[]} input.actions    non-empty list of action ids (e.g.
 *                                    "erc20:transfer", "swap:exec", "read:balance")
 * @param {string[]} [input.targets]  allowed destination addresses. May be
 *                                    empty ONLY if every action is read/simulate.
 * @param {string|number|bigint} [input.maxValueWei]  native-value cap (default "0")
 * @param {string|number|bigint} [input.maxGasWei]    optional gas-fee cap (gasLimit*feePerGas)
 * @param {number} input.expiresAtMs  epoch ms the grant stops being valid
 * @param {string|number} [input.nonce] uniqueness salt (default 0)
 * @param {number} [input.issuedAtMs]  epoch ms issuance time (default Date.now())
 */
export function createSessionGrant({
  provider,
  owner,
  agent,
  chainId,
  actions,
  targets = [],
  maxValueWei = "0",
  maxGasWei,
  expiresAtMs,
  nonce = 0,
  issuedAtMs = Date.now(),
} = {}) {
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  if (!PROVIDER_IDS.includes(normalizedProvider)) {
    fail(`provider must be one of ${PROVIDER_IDS.join(", ")}`);
  }

  const normalizedOwner = normalAddress(owner, "owner");
  const normalizedAgent = normalAddress(agent, "agent");
  if (normalizedOwner === normalizedAgent) fail("agent key must differ from owner wallet");

  const normalizedChainId = normalPositiveInt(chainId, "chainId");

  if (!Array.isArray(actions) || actions.length === 0) fail("actions must be a non-empty array");
  const normalizedActions = [...new Set(actions.map(normalActionId))].sort();

  if (!Array.isArray(targets)) fail("targets must be an array");
  const normalizedTargets = [...new Set(targets.map((t) => normalAddress(t, "target")))].sort();

  const allActionsReadOnly = normalizedActions.every(isReadOnlyAction);
  if (normalizedTargets.length === 0 && !allActionsReadOnly) {
    fail("empty target allowlist is only allowed when every action is read/simulate");
  }

  const normalizedMaxValueWei = normalBigString(maxValueWei, "maxValueWei");
  const normalizedMaxGasWei = maxGasWei == null ? null : normalBigString(maxGasWei, "maxGasWei");

  const normalizedIssuedAtMs = Number(issuedAtMs);
  if (!Number.isFinite(normalizedIssuedAtMs)) fail("issuedAtMs must be a finite number");
  const normalizedExpiresAtMs = Number(expiresAtMs);
  if (!Number.isFinite(normalizedExpiresAtMs)) fail("expiresAtMs must be a finite number");
  if (normalizedExpiresAtMs <= normalizedIssuedAtMs) fail("expiresAtMs must be after issuedAtMs");
  if (normalizedExpiresAtMs - normalizedIssuedAtMs > MAX_SESSION_TTL_MS) {
    fail(`session grant exceeds the hard 24-hour TTL (${MAX_SESSION_TTL_MS} ms)`);
  }

  const normalizedNonce = String(nonce ?? 0);

  const identity = {
    mode: "oracle-session-grant",
    version: 1,
    provider: normalizedProvider,
    owner: normalizedOwner,
    agent: normalizedAgent,
    chainId: normalizedChainId,
    actions: normalizedActions,
    targets: normalizedTargets,
    maxValueWei: normalizedMaxValueWei,
    maxGasWei: normalizedMaxGasWei,
    issuedAtMs: normalizedIssuedAtMs,
    expiresAtMs: normalizedExpiresAtMs,
    nonce: normalizedNonce,
  };

  const id = computeSessionId(identity);
  const grant = { id, ...identity };
  return Object.freeze(grant);
}

/** In-memory revocation registry. Deterministic, no chain dependency — a real
 *  integration backs this with an on-chain revoke (Safe module disable,
 *  ZeroDev/Biconomy session revoke) or an off-chain indexer; the interface
 *  here is what Oracle Control's policy check consumes either way. */
export function createRevocationRegistry() {
  const revoked = new Map(); // sessionId -> { revokedAtMs, reason }
  return {
    revoke(sessionId, { nowMs = Date.now(), reason = null } = {}) {
      if (!sessionId) fail("revoke requires a sessionId");
      if (!revoked.has(sessionId)) revoked.set(sessionId, { revokedAtMs: Number(nowMs), reason });
      return revoked.get(sessionId);
    },
    isRevoked(sessionId) {
      return revoked.has(sessionId);
    },
    revokedAt(sessionId) {
      return revoked.get(sessionId)?.revokedAtMs ?? null;
    },
    get size() {
      return revoked.size;
    },
  };
}

function isRevokedGrant(grant, revocation) {
  if (!revocation) return false;
  if (typeof revocation.isRevoked === "function") return revocation.isRevoked(grant.id);
  if (revocation instanceof Set) return revocation.has(grant.id);
  if (Array.isArray(revocation)) return revocation.includes(grant.id);
  return false;
}

/**
 * Compute a grant's current lifecycle status. Revocation takes precedence
 * over expiry (a revoked-then-expired grant still reports "revoked", which
 * matters for audit trails downstream).
 */
export function sessionStatus(grant, { nowMs = Date.now(), revocation } = {}) {
  if (!grant || grant.mode !== "oracle-session-grant") fail("invalid session grant");
  if (isRevokedGrant(grant, revocation)) return SESSION_STATUS.REVOKED;
  // Fail CLOSED on an unusable clock. `Number(nowMs) >= expiresAtMs` is false
  // for NaN / null / "later" / -Infinity, so a long-dead grant reported ACTIVE
  // and authorized spending at its full cap. `null` is the sharp edge: it slips
  // past the `= Date.now()` default because it is a supplied value, and
  // Number(null) === 0.
  if (!isWindowOpen({ expiresAtMs: grant.expiresAtMs }, nowMs, { inclusive: true })) return SESSION_STATUS.EXPIRED;
  return SESSION_STATUS.ACTIVE;
}

export function isSessionActive(grant, opts = {}) {
  return sessionStatus(grant, opts) === SESSION_STATUS.ACTIVE;
}

/**
 * Authorize a single proposed action against a session grant. Throws a
 * "session: ..." Error on any violation (fail-closed); returns true only when
 * every check passes. This is a pure policy check — it does not sign,
 * prepare, or broadcast anything.
 *
 * @param {object} grant     output of createSessionGrant()
 * @param {object} request
 * @param {string} request.action    action id being attempted
 * @param {number} request.chainId   chain the action targets
 * @param {string} [request.target]  destination address (required unless read/simulate)
 * @param {string|number|bigint} [request.valueWei] native value moved (default 0)
 * @param {string|number|bigint} [request.gasWei]    gasLimit*feePerGas estimate
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @param {object|Set|string[]} [opts.revocation]  registry / set / array of revoked ids
 */
export function assertSessionAuthorized(grant, request = {}, opts = {}) {
  if (!grant || grant.mode !== "oracle-session-grant") fail("invalid session grant");

  const status = sessionStatus(grant, opts);
  if (status === SESSION_STATUS.REVOKED) fail(`session ${grant.id} is revoked`);
  if (status === SESSION_STATUS.EXPIRED) fail(`session ${grant.id} expired at ${grant.expiresAtMs}`);

  const requestedChainId = normalPositiveInt(request.chainId, "request.chainId");
  if (requestedChainId !== grant.chainId) {
    fail(`chain mismatch: session is scoped to ${grant.chainId}, request is ${requestedChainId}`);
  }

  const action = normalActionId(request.action);
  if (!grant.actions.includes(action)) {
    fail(`action "${action}" not permitted by session ${grant.id}`);
  }

  const readOnly = isReadOnlyAction(action);
  if (!readOnly) {
    if (request.target == null || request.target === "") fail("target required for a non-read action");
    const target = normalAddress(request.target, "request.target");
    if (grant.targets.length === 0) fail(`session ${grant.id} has no granted targets (fail-closed)`);
    if (!grant.targets.includes(target)) {
      fail(`target ${target} not permitted by session ${grant.id}`);
    }
  }

  const valueWei = BigInt(normalBigString(request.valueWei ?? "0", "request.valueWei"));
  const maxValueWei = BigInt(grant.maxValueWei);
  if (valueWei > maxValueWei) {
    fail(`value ${valueWei} exceeds session cap ${maxValueWei}`);
  }

  // A gas ceiling on the grant is a promise the grant makes. Honouring it only
  // when the REQUEST volunteers a gasWei made it optional in practice: a
  // requester could omit the field and satisfy a grant whose explicit ceiling
  // would otherwise reject the transaction. If the grant bounds gas, the
  // request must state it.
  if (grant.maxGasWei != null) {
    if (request.gasWei == null) {
      fail("session grant bounds gas but the request omitted gasWei — refusing to authorize unbounded gas");
    }
    const gasWei = BigInt(normalBigString(request.gasWei, "request.gasWei"));
    const maxGasWei = BigInt(grant.maxGasWei);
    if (gasWei > maxGasWei) {
      fail(`gas fee ${gasWei} exceeds session cap ${maxGasWei}`);
    }
  }

  return true;
}

/** Convenience non-throwing wrapper: returns { ok, reason }. */
export function checkSessionAuthorized(grant, request = {}, opts = {}) {
  try {
    assertSessionAuthorized(grant, request, opts);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/** Redacted view safe to log/index — drops nothing secret today (this model
 *  never carries key material) but exists so callers have one stable place to
 *  serialize a grant for an audit trail without hand-picking fields. */
export function toAuditRecord(grant) {
  if (!grant || grant.mode !== "oracle-session-grant") fail("invalid session grant");
  return {
    id: grant.id,
    provider: grant.provider,
    owner: grant.owner,
    agent: grant.agent,
    chainId: grant.chainId,
    actions: grant.actions,
    targets: grant.targets,
    maxValueWei: grant.maxValueWei,
    maxGasWei: grant.maxGasWei,
    issuedAtMs: grant.issuedAtMs,
    expiresAtMs: grant.expiresAtMs,
    nonce: grant.nonce,
  };
}

// Exported for tests / callers that want the raw address/hash validators
// without re-implementing them.
export const _internal = { ADDRESS_RE, HEX32_RE, isReadOnlyAction };
