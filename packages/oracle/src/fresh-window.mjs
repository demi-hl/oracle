// One shared freshness check for every time-bounded authorization.
//
// This defect class has now been found FIVE separate times by four different
// auditors, in five different files: token-transfer-guard, auto-slippage,
// approval-guard, session grants, and the attestation modules. The shape is
// always the same — `Number(nowMs) > Number(expiresAtMs)` is false when nowMs
// is NaN, null, a non-numeric string, or -Infinity, so a broken or attacker-
// influenced clock silently converts a short-lived authorization into a
// permanent one.
//
// Fixing it once per file guarantees the sixth file will have it too. So it
// lives here, and every guard calls this.

/**
 * Assert a time-bounded window is present, coherent, and currently open.
 * Fails CLOSED on any unusable clock or missing bound.
 *
 * @param {object} window            { issuedAtMs, expiresAtMs }
 * @param {number} nowMs             current time
 * @param {string} label             prefix for error messages
 */
export function assertFreshWindow(window, nowMs, label = "guard") {
  const now = Number(nowMs);
  // `null` deserves special mention: it slips past a `= Date.now()` default
  // because it is a *supplied* value, and Number(null) === 0 — which makes
  // every expiry comparison pass.
  if (nowMs == null || !Number.isFinite(now)) {
    throw new Error(`${label}: current time must be a finite number (got ${describe(nowMs)})`);
  }

  const issuedAtMs = Number(window?.issuedAtMs);
  const expiresAtMs = Number(window?.expiresAtMs);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error(`${label}: expiresAtMs is required and must be a finite number`);
  }
  // Expiry is checked BEFORE coherence: an already-expired window is the more
  // useful thing to report, and a test (or caller) that hand-builds an expired
  // window by pulling expiresAtMs back past issuedAtMs still gets "expired"
  // rather than a shape complaint.
  if (now > expiresAtMs) {
    throw new Error(`${label} expired at ${expiresAtMs}, now ${now}`);
  }
  if (window?.issuedAtMs != null) {
    if (!Number.isFinite(issuedAtMs)) {
      throw new Error(`${label}: issuedAtMs must be a finite number when present`);
    }
    if (expiresAtMs <= issuedAtMs) {
      throw new Error(`${label}: expiry must be after issuance`);
    }
  }
  return { now, issuedAtMs, expiresAtMs };
}

/**
 * Non-throwing form for status reporting. Returns false when the clock is
 * unusable, so a caller asking "is this still live?" gets NO rather than a
 * confident yes derived from a broken clock.
 */
export function isWindowOpen(window, nowMs, { inclusive = false } = {}) {
  try {
    const { now, expiresAtMs } = assertFreshWindow(window, nowMs);
    // `inclusive` treats the expiry instant itself as closed, which is what
    // session grants mean by "expired at/after expiresAtMs".
    if (inclusive && now >= expiresAtMs) return false;
    return true;
  } catch {
    return false;
  }
}

function describe(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "number") return String(v);
  return `${typeof v} ${JSON.stringify(String(v)).slice(0, 24)}`;
}
