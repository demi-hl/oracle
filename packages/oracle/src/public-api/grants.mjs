// Oracle Public API — grant reads (Slice D).
//
// Pure, deterministic read functions over an INJECTED grant store. No DB, no
// chain, no clock fallback: callers pass an array/Map of grant records plus an
// explicit `now` (unix seconds). Same inputs always produce the same output.
//
// Imports ONLY from the assigned public peers (policy-schema.mjs) and the
// sibling connect-agent.mjs for the shared no-secret invariant. Never from the
// private executor stack.
//
// Store shape (injected, caller-owned):
//   - an Array or Map whose entries are either
//       a) a raw grant object (policy-schema shape), or
//       b) a wrapper record { grant, revoked?, revokedAt? }.
//   - revocation may also be supplied out-of-band via opts.revoked: a Set /
//     array / Map-like of grant ids and/or revocation keys, or a function
//     (id, grant) => boolean.
//
// Fail-closed rules:
//   - records that do not validate against the public policy schema are
//     EXCLUDED from active listings (a grant that cannot validate cannot
//     authorize anything).
//   - `now` is required for listActiveGrants; without a reference time we
//     cannot prove liveness, so we refuse rather than guess.
//   - every returned object passes the no-secret invariant scan.

import { validateGrant, grantId, isExpired } from "../public-control/policy-schema.mjs";
import { assertNoSecretMaterial } from "./connect-agent.mjs";

export const GRANT_STATUS = Object.freeze({
  ACTIVE: "active",
  EXPIRED: "expired",
  REVOKED: "revoked",
  INVALID: "invalid",
});

function toRecords(store) {
  if (store == null) return [];
  if (Array.isArray(store)) return store;
  if (store instanceof Map) return [...store.values()];
  if (typeof store[Symbol.iterator] === "function") return [...store];
  throw new TypeError("grant store must be an array, Map, or iterable of grant records");
}

function unwrap(record) {
  if (record && typeof record === "object" && !Array.isArray(record) && record.grant != null) {
    return {
      grant: record.grant,
      revoked: record.revoked === true || record.revokedAt != null,
    };
  }
  return { grant: record, revoked: false };
}

function toSafeNow(now) {
  const n = typeof now === "string" ? Number(now.trim()) : Number(now);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new TypeError("an explicit unix-seconds `now` is required (deterministic liveness, no wall-clock fallback)");
  }
  return n;
}

function isRevokedBy(revoked, id, grant) {
  if (revoked == null) return false;
  if (typeof revoked === "function") return revoked(id, grant) === true;
  const keys = [id, grant.revocationKey];
  if (revoked instanceof Set) return keys.some((k) => revoked.has(k));
  if (Array.isArray(revoked)) return keys.some((k) => revoked.includes(k));
  if (typeof revoked.has === "function") return keys.some((k) => revoked.has(k));
  return false;
}

/**
 * Classify a single store record. Returns { status, id, grant } where grant
 * is the normalized public grant (null when invalid). Pure + deterministic.
 */
export function classifyGrant(record, { now, revoked } = {}) {
  const nowSec = toSafeNow(now);
  const { grant: raw, revoked: recordRevoked } = unwrap(record);
  const { ok, grant } = validateGrant(raw);
  if (!ok) return { status: GRANT_STATUS.INVALID, id: null, grant: null };
  const id = grantId(grant);
  // Revocation takes precedence over expiry (matches session-key-model
  // semantics: a revoked-then-expired grant still reports "revoked").
  if (recordRevoked || isRevokedBy(revoked, id, grant)) {
    return { status: GRANT_STATUS.REVOKED, id, grant };
  }
  if (isExpired(grant, nowSec)) return { status: GRANT_STATUS.EXPIRED, id, grant };
  return { status: GRANT_STATUS.ACTIVE, id, grant };
}

/**
 * List grants that are currently ACTIVE: valid under the public policy
 * schema, not expired at `now`, and not revoked (per record flag or the
 * injected `revoked` source). Invalid records are silently excluded
 * (fail closed — they cannot authorize anything).
 *
 * Optional filters: { agentAddress, accountAddress, chainId }.
 *
 * @returns frozen array of { id, grant } sorted by id (deterministic order).
 */
export function listActiveGrants(store, { now, revoked, agentAddress, accountAddress, chainId } = {}) {
  const nowSec = toSafeNow(now);
  const wantAgent = agentAddress != null ? String(agentAddress).trim().toLowerCase() : null;
  const wantAccount = accountAddress != null ? String(accountAddress).trim().toLowerCase() : null;
  const wantChain = chainId != null ? Number(chainId) : null;

  const out = [];
  for (const record of toRecords(store)) {
    const { status, id, grant } = classifyGrant(record, { now: nowSec, revoked });
    if (status !== GRANT_STATUS.ACTIVE) continue;
    if (wantAgent != null && grant.agentAddress !== wantAgent) continue;
    if (wantAccount != null && grant.accountAddress !== wantAccount) continue;
    if (wantChain != null && grant.chainId !== wantChain) continue;
    out.push(Object.freeze({ id, grant }));
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return assertNoSecretMaterial(Object.freeze(out));
}

/**
 * Look up a single grant by its public grant id. Returns
 * { id, status, grant } or null when no record in the store matches.
 * Unlike listActiveGrants this also surfaces expired/revoked grants (with
 * their status) so a UI can explain WHY a grant is not active — but invalid
 * records never match (they have no trustworthy id).
 */
export function getGrant(store, id, { now, revoked } = {}) {
  const nowSec = toSafeNow(now);
  const wanted = String(id ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wanted)) return null;
  for (const record of toRecords(store)) {
    const res = classifyGrant(record, { now: nowSec, revoked });
    if (res.status === GRANT_STATUS.INVALID) continue;
    if (res.id === wanted) {
      return assertNoSecretMaterial(
        Object.freeze({ id: res.id, status: res.status, grant: res.grant })
      );
    }
  }
  return null;
}
