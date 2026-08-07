// Oracle Control — public grant policy schema (Slice A).
//
// Oracle Control is DETERMINISTIC AUTHORIZATION: a grant either validates or it
// does not, with no advisory judgement involved (that is Oracle Router's job,
// and Router output must never gate anything here).
//
// This module is dependency-free (node builtins only, no npm packages) and
// fully deterministic: same input object => same normalized grant => same
// canonical string => same grant id, regardless of key order, address casing,
// array ordering, or numeric representation (number / bigint / decimal string).
//
// Self-custody boundary: a grant only ever references PUBLIC material —
// chain id, the agent's public address, the user's own account address,
// action scopes, target contracts, spend/gas/slippage ceilings, expiry,
// nonce, and a public revocation key identifier. Nothing here may carry or
// derive private keys, bearer tokens, keystore paths, or session secrets.
//
// Fail-closed rules enforced by validateGrant / normalizeGrant:
//   - every required field must be present (expiry, chain, agent, account, ...)
//   - unknown fields are rejected (no smuggling extra authority)
//   - broad wildcard actions are rejected by default ("*", "*:*", "verb:*")
//   - empty targets are only allowed when EVERY action is read/simulate scoped
//   - expiresAt is required and, when a reference `now` is supplied, must be
//     strictly in the future

import { createHash } from "node:crypto";

export const GRANT_VERSION = 1;

/** Every field is required. Order here is documentation only; canonical form
 *  always sorts keys alphabetically. */
export const REQUIRED_FIELDS = Object.freeze([
  "chainId",
  "agentAddress",
  "accountAddress",
  "actions",
  "targets",
  "maxValueWei",
  "maxGasWei",
  "maxSlippageBps",
  "expiresAt",
  "nonce",
  "revocationKey",
]);

/** Action verbs that never touch state; only these may have empty targets. */
export const READONLY_ACTION_VERBS = Object.freeze(["read", "simulate"]);

export const MAX_SLIPPAGE_BPS = 10_000;
export const MAX_GRANT_TTL_SECONDS = 24 * 60 * 60;
export const MAX_NONCE_LENGTH = 128;
export const MAX_REVOCATION_KEY_LENGTH = 256;
export const MAX_ACTIONS = 64;
export const MAX_TARGETS = 256;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// verb:resource — lowercase verb, resource may carry dots/dashes/underscores.
const ACTION_RE = /^[a-z][a-z0-9_-]*:[a-z0-9._-]+$/;
// wildcard-bearing action (only accepted when explicitly opted in, and never
// with a wildcard verb).
const ACTION_WILDCARD_RE = /^[a-z][a-z0-9_-]*:\*$/;
const NONCE_RE = /^[A-Za-z0-9._:-]+$/;
const REVOCATION_KEY_RE = /^[A-Za-z0-9._:-]+$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

export class GrantValidationError extends Error {
  constructor(errors) {
    const lines = errors.map((e) => `${e.field}: ${e.message}`);
    super(`invalid grant (${errors.length} error${errors.length === 1 ? "" : "s"}): ${lines.join("; ")}`);
    this.name = "GrantValidationError";
    this.errors = errors;
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Parse a non-negative integer amount (number | bigint | decimal string)
 *  into a canonical decimal string. Returns null when unparseable. */
function toAmountString(v) {
  if (typeof v === "bigint") {
    return v >= 0n ? v.toString(10) : null;
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    return String(v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!DECIMAL_RE.test(s)) return null;
    return s;
  }
  return null;
}

function toSafeInt(v) {
  if (typeof v === "bigint") {
    if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(v);
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    return v;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!DECIMAL_RE.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** True when the action verb is read-only (read/simulate). */
export function isReadonlyAction(action) {
  const verb = String(action).split(":")[0];
  return READONLY_ACTION_VERBS.includes(verb);
}

/**
 * Validate a grant. Never throws; returns { ok, errors, grant } where `grant`
 * is the normalized form when ok, else null.
 *
 * Options:
 *   allowWildcardActions  (default false) — permit "verb:*" actions. Broad
 *                         wildcards ("*", "*:*", wildcard verbs) are ALWAYS
 *                         rejected regardless of this flag.
 *   now                   (unix seconds) — when provided, expiresAt must be
 *                         strictly greater than it. Pass explicitly for
 *                         deterministic validation; omitted means no liveness
 *                         check (pure shape validation).
 */
export function validateGrant(input, opts = {}) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });

  if (!isPlainObject(input)) {
    push("grant", "grant must be a plain object");
    return { ok: false, errors, grant: null };
  }

  // Fail closed on unknown fields.
  for (const key of Object.keys(input)) {
    if (!REQUIRED_FIELDS.includes(key)) push(key, "unknown field is not allowed");
  }
  for (const key of REQUIRED_FIELDS) {
    if (!(key in input) || input[key] == null) push(key, "required field is missing");
  }
  if (errors.length) return { ok: false, errors, grant: null };

  const out = {};

  // chainId
  const chainId = toSafeInt(input.chainId);
  if (chainId == null || chainId <= 0) push("chainId", "must be a positive integer chain id");
  else out.chainId = chainId;

  // addresses
  for (const field of ["agentAddress", "accountAddress"]) {
    const v = input[field];
    if (typeof v !== "string" || !ADDRESS_RE.test(v.trim())) {
      push(field, "must be a 0x-prefixed 20-byte hex address");
    } else {
      out[field] = v.trim().toLowerCase();
    }
  }

  // actions
  if (!Array.isArray(input.actions) || input.actions.length === 0) {
    push("actions", "must be a non-empty array of action scopes");
  } else if (input.actions.length > MAX_ACTIONS) {
    push("actions", `too many actions (max ${MAX_ACTIONS})`);
  } else {
    const actions = [];
    for (const raw of input.actions) {
      const a = typeof raw === "string" ? raw.trim() : null;
      if (!a) {
        push("actions", "action entries must be non-empty strings");
        continue;
      }
      if (a.includes("*")) {
        if (opts.allowWildcardActions === true && ACTION_WILDCARD_RE.test(a)) {
          actions.push(a);
        } else {
          push("actions", `broad wildcard action "${a}" is rejected (fail closed)`);
        }
        continue;
      }
      if (!ACTION_RE.test(a)) {
        push("actions", `malformed action "${a}" (expected verb:resource)`);
        continue;
      }
      actions.push(a);
    }
    out.actions = [...new Set(actions)].sort();
  }

  // targets
  if (!Array.isArray(input.targets)) {
    push("targets", "must be an array of contract addresses");
  } else if (input.targets.length > MAX_TARGETS) {
    push("targets", `too many targets (max ${MAX_TARGETS})`);
  } else {
    const targets = [];
    for (const raw of input.targets) {
      const t = typeof raw === "string" ? raw.trim() : null;
      if (!t || !ADDRESS_RE.test(t)) {
        push("targets", `target "${raw}" must be a 0x-prefixed 20-byte hex address (wildcards not allowed)`);
        continue;
      }
      targets.push(t.toLowerCase());
    }
    out.targets = [...new Set(targets)].sort();
    if (out.targets.length === 0 && Array.isArray(out.actions)) {
      const nonReadonly = out.actions.filter((a) => !isReadonlyAction(a));
      if (nonReadonly.length > 0 || out.actions.length === 0) {
        push(
          "targets",
          `empty targets are only allowed for read/simulate scopes (blocked by: ${nonReadonly.join(", ") || "no valid actions"})`
        );
      }
    }
  }

  // amounts
  for (const field of ["maxValueWei", "maxGasWei"]) {
    const amt = toAmountString(input[field]);
    if (amt == null) push(field, "must be a non-negative integer wei amount");
    else out[field] = amt;
  }

  // slippage
  const bps = toSafeInt(input.maxSlippageBps);
  if (bps == null || bps > MAX_SLIPPAGE_BPS) {
    push("maxSlippageBps", `must be an integer between 0 and ${MAX_SLIPPAGE_BPS}`);
  } else {
    out.maxSlippageBps = bps;
  }

  // expiry — required (checked above); must be a positive unix-seconds int and,
  // when `now` is supplied, strictly in the future.
  // Date-renderable ceiling in unix seconds. JS Date maxes at 8.64e15 ms, so a
  // seconds value above 8.64e12 overflows the renderer (isoUtc does *1000).
  // Also well within the AA lane's uint48 bound, so a schema-valid expiry always
  // fits both the on-chain validUntil field and the human render. Reject rather
  // than render a bogus far-future date (fail closed on the seconds-vs-ms mistake).
  const MAX_UNIX_SECONDS = 8_640_000_000_000;
  const expiresAt = toSafeInt(input.expiresAt);
  if (expiresAt == null || expiresAt <= 0) {
    push("expiresAt", "must be a positive unix-seconds timestamp");
  } else if (expiresAt > MAX_UNIX_SECONDS) {
    push("expiresAt", "exceeds the max unix-seconds timestamp (pass seconds, not milliseconds)");
  } else {
    out.expiresAt = expiresAt;
    if (opts.now != null) {
      const now = toSafeInt(opts.now);
      if (now == null) push("expiresAt", "opts.now must be a unix-seconds integer");
      else if (expiresAt <= now) push("expiresAt", `grant is expired (expiresAt ${expiresAt} <= now ${now})`);
      else if (expiresAt - now > MAX_GRANT_TTL_SECONDS) {
        push("expiresAt", `grant exceeds the hard 24-hour TTL (${MAX_GRANT_TTL_SECONDS} seconds)`);
      }
    }
  }

  // nonce
  const nonce =
    typeof input.nonce === "string"
      ? input.nonce.trim()
      : toSafeInt(input.nonce) != null
        ? String(toSafeInt(input.nonce))
        : null;
  if (!nonce || nonce.length > MAX_NONCE_LENGTH || !NONCE_RE.test(nonce)) {
    push("nonce", `must be a non-empty string (max ${MAX_NONCE_LENGTH} chars, [A-Za-z0-9._:-])`);
  } else {
    out.nonce = nonce;
  }

  // revocationKey — a PUBLIC identifier used to revoke this grant; never a secret.
  const rk = typeof input.revocationKey === "string" ? input.revocationKey.trim() : null;
  if (!rk || rk.length > MAX_REVOCATION_KEY_LENGTH || !REVOCATION_KEY_RE.test(rk)) {
    push("revocationKey", `must be a non-empty public identifier (max ${MAX_REVOCATION_KEY_LENGTH} chars, [A-Za-z0-9._:-])`);
  } else {
    out.revocationKey = rk;
  }

  if (errors.length) return { ok: false, errors, grant: null };
  return { ok: true, errors: [], grant: out };
}

/** Validate + normalize; throws GrantValidationError on any failure. */
export function normalizeGrant(input, opts = {}) {
  const { ok, errors, grant } = validateGrant(input, opts);
  if (!ok) throw new GrantValidationError(errors);
  return grant;
}

/**
 * Deterministic canonical JSON for a grant: validates/normalizes first, then
 * serializes with alphabetically sorted keys (arrays already sorted + deduped
 * by normalization). Identical grants — regardless of input key order, address
 * casing, or numeric representation — always produce the identical string.
 */
export function canonicalizeGrant(input, opts = {}) {
  const g = normalizeGrant(input, opts);
  const keys = Object.keys(g).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(g[k])}`);
  return `{"version":${GRANT_VERSION},${parts.join(",")}}`;
}

/** sha256 hex of the canonical form — stable public identifier for a grant. */
export function grantId(input, opts = {}) {
  return createHash("sha256").update(canonicalizeGrant(input, opts), "utf8").digest("hex");
}

/** Deterministic expiry check against an explicit unix-seconds `now`. */
export function isExpired(grant, nowSeconds) {
  const now = toSafeInt(nowSeconds);
  const exp = toSafeInt(isPlainObject(grant) ? grant.expiresAt : null);
  if (now == null || exp == null) return true; // fail closed
  return exp <= now;
}
