// Oracle Control — grant audit + active-permission indexer (Slice F).
//
// Deterministic, storage-agnostic reconstruction of grant state from an
// append-only event log. Oracle Control is DETERMINISTIC AUTHORIZATION: this
// module never guesses, never consults Oracle Router (advisory), and never
// keeps its own mutable state. The chain (or whatever emits the event log)
// is the sole source of truth; this file is a pure projection of that log
// plus an explicit reference `now`.
//
// Hard boundaries for this file:
//   - No imports outside src/public-control/policy-schema.mjs (grant identity
//     + expiry helpers are reused from there, never duplicated).
//   - No import from the private executor stack, no RPC/chain calls, no I/O.
//   - Pure functions only: reconstructGrantIndex(events, opts) always returns
//     the same result for the same (events, opts.now) — same events replayed
//     after a "restart" (fresh process, no cache, no prior in-memory state)
//     reconstruct the identical active set. Input array order never matters.
//   - Audit/output records are built from an explicit field whitelist only.
//     Unknown/extra properties on raw events (or on a rejected grant payload)
//     are NEVER copied into output, so a poisoned event can't smuggle a
//     secret (API key, session key, keystore path, ...) into the index.
//
// Event log shape (each entry is a plain object; unknown extra fields are
// ignored, never echoed):
//   { type: "grantCreated",   at: <unix seconds>, grant: <raw grant>, grantId?: <string> }
//   { type: "grantActivated", at: <unix seconds>, grantId: <string> }
//   { type: "grantRevoked",   at: <unix seconds>, grantId: <string>, reason?: <string> }
//   { type: "grantExpired",   at: <unix seconds>, grantId: <string> }
//
// `grantId` on a grantCreated event is optional: when omitted it is derived
// from the grant payload itself via policy-schema's grantId() (content
// addressed identity). When supplied it is cross-checked against the derived
// id and the event is rejected on mismatch (fail closed, no id spoofing).
//
// Status precedence (revocation beats expiry beats activity — mirrors the
// same precedence used by session-key-model.mjs's sessionStatus): a grant
// that was revoked and later would also have expired still reports revoked.
//   REVOKED > EXPIRED > ACTIVE > PENDING > UNKNOWN
// Only ACTIVE grants are ever included in the `active` set.

import { normalizeGrant, grantId as computeGrantId, isExpired, GrantValidationError } from "./policy-schema.mjs";

export const GRANT_EVENT_TYPES = Object.freeze([
  "grantCreated",
  "grantActivated",
  "grantRevoked",
  "grantExpired",
]);

export const GRANT_STATUS = Object.freeze({
  ACTIVE: "active",
  PENDING: "pending",
  REVOKED: "revoked",
  EXPIRED: "expired",
  UNKNOWN: "unknown",
  INVALID: "invalid",
});

/** Fields ever allowed into an audit/output record. Nothing outside this
 *  whitelist can reach the returned index, no matter what a raw event or
 *  grant payload carries. All of these are public-by-design fields already
 *  enforced by policy-schema.mjs's REQUIRED_FIELDS. */
const GRANT_SUMMARY_FIELDS = Object.freeze([
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

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function toUnixSeconds(v) {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim()))) {
    return Number(v.trim());
  }
  return null;
}

function toSafeString(v, maxLen = 512) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function grantSummary(normalizedGrant) {
  const out = {};
  for (const field of GRANT_SUMMARY_FIELDS) out[field] = normalizedGrant[field];
  return out;
}

/**
 * Parse one raw event into a strictly-whitelisted internal shape. Never
 * throws. Extra/unknown properties on `raw` are silently dropped (this is
 * the point — it's the no-secret-leak boundary for whatever noise a chain
 * indexer/relay might attach to an event object).
 *
 * Returns { ok: true, event } or { ok: false, error: { type, at, grantId, message } }.
 */
function parseEvent(raw, opts) {
  if (!isPlainObject(raw)) {
    return { ok: false, error: { type: null, at: null, grantId: null, message: "event must be a plain object" } };
  }

  const type = typeof raw.type === "string" ? raw.type : null;
  const at = toUnixSeconds(raw.at);
  const grantIdHint = typeof raw.grantId === "string" && raw.grantId.trim() ? raw.grantId.trim() : null;

  if (!GRANT_EVENT_TYPES.includes(type)) {
    return { ok: false, error: { type, at, grantId: grantIdHint, message: `unknown event type "${String(type)}"` } };
  }
  if (at == null) {
    return { ok: false, error: { type, at: null, grantId: grantIdHint, message: "event.at must be a unix-seconds number" } };
  }

  if (type === "grantCreated") {
    if (!isPlainObject(raw.grant)) {
      return { ok: false, error: { type, at, grantId: grantIdHint, message: "grantCreated requires a grant payload" } };
    }
    let normalized;
    try {
      // Identity + shape validation only — deliberately WITHOUT opts.now, so
      // a grant that has since expired can still be identified/reconstructed
      // (liveness is evaluated separately against the caller's `now`).
      normalized = normalizeGrant(raw.grant, { allowWildcardActions: opts.allowWildcardActions });
    } catch (e) {
      const message = e instanceof GrantValidationError ? e.message : String(e?.message || e);
      return { ok: false, error: { type, at, grantId: grantIdHint, message } };
    }
    const derivedId = computeGrantId(raw.grant, { allowWildcardActions: opts.allowWildcardActions });
    if (grantIdHint && grantIdHint !== derivedId) {
      return {
        ok: false,
        error: { type, at, grantId: grantIdHint, message: "grantId does not match content-derived grant identity (fail closed)" },
      };
    }
    return { ok: true, event: { type, at, grantId: derivedId, grant: normalized } };
  }

  // grantActivated / grantRevoked / grantExpired all reference an existing
  // grant purely by id — they never carry grant material.
  if (!grantIdHint) {
    return { ok: false, error: { type, at, grantId: null, message: `${type} requires a grantId` } };
  }
  const reason = type === "grantRevoked" ? toSafeString(raw.reason) : null;
  return { ok: true, event: { type, at, grantId: grantIdHint, reason } };
}

function minOf(list) {
  return list.length ? list.reduce((a, b) => Math.min(a, b)) : null;
}

/**
 * Reconstruct the deterministic grant index from a raw event log.
 *
 * @param {object[]} events        raw event log (any order, any origin)
 * @param {object} opts
 * @param {number} opts.now        REQUIRED unix-seconds reference time. All
 *                                 reconstruction is relative to this instant;
 *                                 pass the same `now` to get the same result.
 * @param {boolean} [opts.allowWildcardActions] forwarded to policy-schema.
 *
 * @returns {{
 *   active: object[],       grants currently ACTIVE, sorted by grantId
 *   historical: object[],   everything else (pending/revoked/expired/unknown/invalid), sorted by grantId
 *   all: object[],          active + historical, sorted by grantId
 *   invalidEvents: object[] malformed/rejected raw events (whitelisted fields only)
 * }}
 */
export function reconstructGrantIndex(events, opts = {}) {
  const now = toUnixSeconds(opts.now);
  if (now == null) throw new Error("grant-indexer: opts.now (unix seconds) is required");
  if (!Array.isArray(events)) throw new Error("grant-indexer: events must be an array");

  const invalidEvents = [];
  /** grantId -> { created: [], activated: [], revoked: [], expired: [] } */
  const byId = new Map();

  function bucket(id) {
    if (!byId.has(id)) {
      byId.set(id, { created: [], activated: [], revoked: [], expired: [] });
    }
    return byId.get(id);
  }

  for (const raw of events) {
    const parsed = parseEvent(raw, opts);
    if (!parsed.ok) {
      invalidEvents.push(parsed.error);
      continue;
    }
    const ev = parsed.event;
    // Chain is source of truth for what has already happened: an event dated
    // after the reconstruction instant hasn't occurred *yet* from this
    // vantage point, so it is excluded rather than applied early.
    if (ev.at > now) continue;

    const b = bucket(ev.grantId);
    if (ev.type === "grantCreated") {
      // Same content-derived id => identical normalized grant; duplicate
      // creations are idempotent. Keep the earliest-by-time occurrence so
      // createdAt is stable and order-independent.
      const existing = b.created[0];
      if (!existing || ev.at < existing.at) b.created = [ev];
    } else if (ev.type === "grantActivated") {
      b.activated.push(ev);
    } else if (ev.type === "grantRevoked") {
      b.revoked.push(ev);
    } else if (ev.type === "grantExpired") {
      b.expired.push(ev);
    }
  }

  const records = [];
  for (const [id, b] of byId.entries()) {
    const createdEvent = b.created[0] || null;
    const createdAt = createdEvent ? createdEvent.at : null;
    const activatedAt = minOf(b.activated.map((e) => e.at));
    const revokedAt = minOf(b.revoked.map((e) => e.at));
    const explicitExpiredAt = minOf(b.expired.map((e) => e.at));

    const grant = createdEvent ? createdEvent.grant : null;
    const schemaExpired = grant ? isExpired(grant, now) : false;
    const expiredAt = explicitExpiredAt != null ? explicitExpiredAt : schemaExpired ? grant.expiresAt : null;

    let status;
    if (!createdEvent) {
      // Lifecycle events (activated/revoked/expired) referencing a grantId
      // we never saw a valid grantCreated for. Never active — there is no
      // grant content to authorize against.
      status = GRANT_STATUS.UNKNOWN;
    } else if (b.revoked.length > 0) {
      status = GRANT_STATUS.REVOKED;
    } else if (explicitExpiredAt != null || schemaExpired) {
      status = GRANT_STATUS.EXPIRED;
    } else if (b.activated.length > 0) {
      status = GRANT_STATUS.ACTIVE;
    } else {
      status = GRANT_STATUS.PENDING;
    }

    const record = {
      grantId: id,
      status,
      createdAt,
      activatedAt,
      revokedAt,
      expiredAt,
      reason: b.revoked.length > 0 ? toSafeString(b.revoked.map((e) => e.reason).find(Boolean) || null) : null,
      grant: grant ? grantSummary(grant) : null,
    };
    records.push(record);
  }

  records.sort((a, b) => (a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0));
  invalidEvents.sort((a, b) => {
    const at = (a.at ?? -Infinity) - (b.at ?? -Infinity);
    if (at !== 0) return at;
    const ai = a.grantId || "";
    const bi = b.grantId || "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  const active = records.filter((r) => r.status === GRANT_STATUS.ACTIVE);
  const historical = records.filter((r) => r.status !== GRANT_STATUS.ACTIVE);

  return Object.freeze({
    active: Object.freeze(active),
    historical: Object.freeze(historical),
    all: Object.freeze(records),
    invalidEvents: Object.freeze(invalidEvents),
  });
}

/** Convenience: is a single grant id active right now, per the given log? */
export function isGrantActive(events, grantId, opts = {}) {
  const { active } = reconstructGrantIndex(events, opts);
  return active.some((r) => r.grantId === grantId);
}

/** Convenience: look up one grant's reconstructed record (or null). */
export function getGrantRecord(events, grantId, opts = {}) {
  const { all } = reconstructGrantIndex(events, opts);
  return all.find((r) => r.grantId === grantId) || null;
}
