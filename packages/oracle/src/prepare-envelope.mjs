// Canonical prepare envelope shared by Oracle prepare helpers and the local operator.
// The versioned checksum binds payload and freshness metadata. It detects mutation.
// Optional HMAC (ORACLE_STAMP_HMAC_SECRET) adds keyed integrity when configured.
// Signer-owned policy, not this public checksum alone, authorizes execution.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const PREPARE_VERSION = 2;
/** Default max age for a prepared envelope at sign time (ms). */
export const PREPARE_MAX_AGE_MS = 5 * 60 * 1000;
/**
 * Hard ceiling for maxAgeMs. Caller/agent cannot widen past this.
 * Override upward only via signer-process env ORACLE_PREPARE_HARD_MAX_AGE_MS.
 */
export const PREPARE_HARD_MAX_AGE_MS = (() => {
  const n = Number(process.env.ORACLE_PREPARE_HARD_MAX_AGE_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000; // 30 minutes
})();

/** Resolve max age: default 5m, never above hard max (even if caller passes MAX_SAFE_INTEGER). */
export function resolvePrepareMaxAgeMs(requested) {
  const base =
    requested == null || requested === ""
      ? PREPARE_MAX_AGE_MS
      : Number(requested);
  if (!Number.isFinite(base) || base < 0) return PREPARE_MAX_AGE_MS;
  return Math.min(base, PREPARE_HARD_MAX_AGE_MS);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function secretFrom(env) {
  const s = String(env?.ORACLE_STAMP_HMAC_SECRET || "").trim();
  return s.length >= 16 ? s : "";
}

function stampSecret(env = process.env) {
  // The signer process owns its policy. An options env is useful for isolated
  // tests and unkeyed clients, but cannot shadow a real process secret.
  return secretFrom(process.env) || secretFrom(env);
}

function requireMac(env = process.env) {
  return String(process.env.ORACLE_STAMP_REQUIRE_MAC || "").trim() === "1" ||
    String(env?.ORACLE_STAMP_REQUIRE_MAC || "").trim() === "1";
}

/** Fields that bind the envelope (must not include the stamp fields themselves). */
export function prepareBodyForHash(prepared) {
  const {
    oraclePrepared,
    prepareHash,
    prepareMac,
    note,
    ...body
  } = prepared || {};
  return body;
}

export function computePrepareHash(prepared) {
  const body = prepareBodyForHash(prepared);
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

export function computePrepareMac(prepareHash, secret = stampSecret()) {
  if (!secret) return "";
  return createHmac("sha256", secret).update(String(prepareHash)).digest("hex");
}

function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a), "hex");
    const bb = Buffer.from(String(b), "hex");
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Stamp a prepare result. Call at the end of every prepare helper.
 * @param {object} payload  provider-specific prepare fields (action/tx/psbt/...)
 */
export function stampPrepared(payload, { provider, kind, env = process.env } = {}) {
  if (!payload || typeof payload !== "object") throw new Error("stampPrepared: payload object required");
  const base = {
    ...payload,
    provider: payload.provider || provider,
    kind: payload.kind || kind,
    requiresUserSignature: payload.requiresUserSignature !== false,
    signingReady: false,
    broadcastReady: false,
    executionReady: false,
  };
  if (!base.provider) throw new Error("stampPrepared: provider required");
  if (!base.kind) throw new Error("stampPrepared: kind required");
  const preparedAt = Date.now();
  const expiresAt = preparedAt + PREPARE_MAX_AGE_MS;
  const prepareVersion = PREPARE_VERSION;
  const withMeta = { ...base, preparedAt, expiresAt, prepareVersion };
  const prepareHash = computePrepareHash(withMeta);
  const secret = stampSecret(env);
  const prepareMac = secret ? computePrepareMac(prepareHash, secret) : undefined;
  const out = {
    ...withMeta,
    oraclePrepared: true,
    prepareHash,
  };
  if (prepareMac) out.prepareMac = prepareMac;
  return out;
}

/**
 * Verify a prepared envelope before operator sign.
 * @throws on mismatch / expiry / missing stamp
 */
export function assertPreparedEnvelope(prepared, {
  maxAgeMs = PREPARE_MAX_AGE_MS,
  nowMs = Date.now(),
  providers = null,
  kinds = null,
  label = "operator",
  env = process.env,
} = {}) {
  if (!prepared || typeof prepared !== "object") {
    throw new Error(`${label}: prepared envelope object required`);
  }
  if (prepared.oraclePrepared !== true) {
    throw new Error(
      `${label}: prepared integrity envelope missing — use an @oracle-agent/oracle prepare result`,
    );
  }
  if (Number(prepared.prepareVersion) !== PREPARE_VERSION) {
    throw new Error(`${label}: unsupported prepareVersion ${prepared.prepareVersion}`);
  }
  const expected = computePrepareHash(prepared);
  if (String(prepared.prepareHash || "") !== expected) {
    throw new Error(`${label}: prepareHash mismatch — payload was altered after prepare`);
  }

  const secret = stampSecret(env);
  const mac = String(prepared.prepareMac || "");
  // The MAC used to be enforced only when it was PRESENT or when
  // ORACLE_STAMP_REQUIRE_MAC=1. That is the classic optional-MAC downgrade:
  // prepareHash is an unkeyed sha256 an attacker can recompute via the
  // exported computePrepareHash, so stripping prepareMac and recomputing the
  // hash let a mutated payload pass a default-posture verifier.
  //
  // A verifier that HOLDS the stamp secret is by definition in keyed mode, so
  // it now requires the MAC rather than treating its absence as opt-out. An
  // attacker can still strip the field, but they cannot forge it, and a
  // verifier with no secret configured is unchanged (checksum-only, exactly as
  // documented — the signer's own policy remains the authoritative wall).
  if (requireMac(env) || mac || secret) {
    if (!secret) {
      throw new Error(
        `${label}: prepareMac present or ORACLE_STAMP_REQUIRE_MAC=1 but ORACLE_STAMP_HMAC_SECRET missing in signer`,
      );
    }
    const expectedMac = computePrepareMac(expected, secret);
    if (!mac || !safeEqualHex(mac, expectedMac)) {
      throw new Error(`${label}: prepareMac mismatch — stamp not from trusted preparer`);
    }
  }

  const preparedAt = Number(prepared.preparedAt);
  const expiresAt = Number(prepared.expiresAt);
  const effectiveMax = resolvePrepareMaxAgeMs(maxAgeMs);
  const age = nowMs - preparedAt;
  const lifetime = expiresAt - preparedAt;
  if (
    !Number.isFinite(age) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(lifetime) ||
    age < 0 ||
    lifetime <= 0 ||
    lifetime > PREPARE_HARD_MAX_AGE_MS ||
    age > effectiveMax ||
    nowMs > expiresAt
  ) {
    throw new Error(
      `${label}: prepare envelope expired or clock-skewed (ageMs=${age}, max=${effectiveMax})`,
    );
  }
  if (providers) {
    const allow = new Set(providers);
    if (!allow.has(prepared.provider)) {
      throw new Error(`${label}: provider ${prepared.provider} not allowed here`);
    }
  }
  if (kinds) {
    const allow = new Set(kinds);
    if (!allow.has(prepared.kind)) {
      throw new Error(`${label}: kind ${prepared.kind} not allowed here`);
    }
  }
  return true;
}
