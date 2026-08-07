/**
 * Metered API access for the public data plane.
 *
 * The plane already serves portfolio, approvals and NFTs across 14 chains
 * including Solana and Bitcoin. That is the product Zerion and Zapper charge
 * for, and Oracle gives it away to anyone who can reach the port. Per-IP rate
 * limiting stops abuse but cannot tell a paying integrator from a stranger.
 *
 * Design constraints, inherited from the modules this sits next to:
 *
 *   - No database. Keys are self-describing and HMAC-signed, exactly like the
 *     gate's session tokens, so verification needs only the secret.
 *   - No secrets in the key. A key names a tier and an expiry, nothing else.
 *   - Injected clock and store. Same-inputs-same-output, like grants.mjs.
 *   - Fails CLOSED on a bad signature, OPEN on no key at all — an unkeyed
 *     request is the existing free tier, not an error, so this cannot break
 *     the current public plane.
 *
 * Locals Only holders get the paid tier free. The NFT is the license.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const TIERS = Object.freeze({
  // Requests per minute. `free` mirrors today's unauthenticated behaviour so
  // adding this layer changes nothing for existing callers.
  free: Object.freeze({ name: "free", rpm: 30, chains: 14, history: false }),
  holder: Object.freeze({ name: "holder", rpm: 300, chains: 14, history: true }),
  build: Object.freeze({ name: "build", rpm: 300, chains: 14, history: true }),
  scale: Object.freeze({ name: "scale", rpm: 3000, chains: 14, history: true }),
});

export const DEFAULT_TIER = "free";

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mint a key. Operator-side only — this is never called from a request path.
 */
export function issueKey({ subject, tier = "build", secret, ttlMs = 365 * 24 * 60 * 60 * 1000, now = Date.now() }) {
  if (!TIERS[tier]) throw new Error(`unknown tier: ${tier}`);
  if (!subject) throw new Error("subject required");
  if (!secret) throw new Error("secret required");
  const payload = Buffer.from(
    JSON.stringify({ sub: String(subject), tier, exp: now + ttlMs }),
  ).toString("base64url");
  return `ok_${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a key. Returns the resolved tier record, never throws on bad input.
 *
 * An absent key resolves to the free tier: the public plane must keep working
 * for anonymous callers. A PRESENT but invalid key resolves to `null` so the
 * caller can 401 — silently downgrading a forged key to free would let an
 * attacker probe for which keys exist.
 */
export function readKey(raw, { secret, now = Date.now() } = {}) {
  const token = String(raw || "").trim();
  if (!token) return { tier: TIERS[DEFAULT_TIER], subject: null, anonymous: true };
  if (!token.startsWith("ok_")) return null;
  try {
    const [payload, signature] = token.slice(3).split(".");
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload, secret));
    const supplied = Buffer.from(signature);
    // Length first: timingSafeEqual throws on a length mismatch.
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!claims?.sub || !TIERS[claims.tier]) return null;
    if (!Number.isFinite(claims.exp) || claims.exp < now) return null;
    return { tier: TIERS[claims.tier], subject: claims.sub, anonymous: false, expiresAt: claims.exp };
  } catch {
    return null;
  }
}

/**
 * Resolve the effective tier for a request.
 *
 * Holder status wins over the key's own tier when it is better, so a holder who
 * never bought a key still gets paid limits. It never DOWNGRADES a paid key.
 */
export function resolveAccess({ key, isHolder = false, secret, now = Date.now() } = {}) {
  const read = readKey(key, { secret, now });
  if (read === null) return { ok: false, reason: "invalid-key" };
  let tier = read.tier;
  if (isHolder && tier.rpm < TIERS.holder.rpm) tier = TIERS.holder;
  return { ok: true, tier, subject: read.subject, anonymous: read.anonymous, isHolder };
}

/**
 * Usage accounting over an injected store, so the caller owns persistence.
 * Store shape: Map<subject, { windowStart, count }>.
 */
export function meter({ store, subject, rpm, now = Date.now(), windowMs = 60_000 }) {
  const id = subject || "anonymous";
  const entry = store.get(id);
  if (!entry || now - entry.windowStart >= windowMs) {
    store.set(id, { windowStart: now, count: 1 });
    return { allowed: true, remaining: rpm - 1, resetInMs: windowMs };
  }
  if (entry.count >= rpm) {
    return { allowed: false, remaining: 0, resetInMs: entry.windowStart + windowMs - now };
  }
  entry.count += 1;
  return { allowed: true, remaining: rpm - entry.count, resetInMs: entry.windowStart + windowMs - now };
}

/** Public, non-secret description of the plans. Safe to serve from the API. */
export function describePlans() {
  return Object.values(TIERS).map((t) => ({
    tier: t.name,
    requestsPerMinute: t.rpm,
    chains: t.chains,
    history: t.history,
    price: t.name === "free" || t.name === "holder" ? 0 : null,
    note: t.name === "holder" ? "Included with a Locals Only NFT" : undefined,
  }));
}
