// Oracle Control — human-readable grant renderer (Slice A).
//
// Renders a validated public grant into deterministic plain text a user can
// review before approving. Rendering is a PRESENTATION of the deterministic
// policy only — it never adds, removes, or reinterprets authority, and it only
// ever surfaces public grant material (no keys, tokens, paths, or secrets).
//
// Output is byte-for-byte deterministic for a given grant: fixed field order,
// fixed labels, UTC timestamps derived purely from expiresAt, and the sha256
// grant id from the canonical form. Tests assert exact output.

import { normalizeGrant, grantId, isReadonlyAction, GRANT_VERSION } from "./policy-schema.mjs";

const LABEL_WIDTH = 14;

function row(label, value) {
  return `${(label + ":").padEnd(LABEL_WIDTH)}${value}`;
}

/** Deterministic UTC ISO string from unix seconds. */
function isoUtc(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

/** "50 bps (0.50%)" — deterministic fixed-2 percentage. */
export function formatBps(bps) {
  return `${bps} bps (${(bps / 100).toFixed(2)}%)`;
}

/** Group wei digits for readability: 1000000 -> "1,000,000". Deterministic. */
export function formatWei(weiString) {
  const s = String(weiString);
  return `${s.replace(/\B(?=(\d{3})+(?!\d))/g, ",")} wei`;
}

/**
 * Render a grant as deterministic human-readable text.
 * Validates/normalizes first (throws GrantValidationError on bad input), so a
 * grant that cannot be rendered is a grant that cannot be authorized.
 */
export function renderGrant(input, opts = {}) {
  const g = normalizeGrant(input, opts);
  const id = grantId(g);
  const readonlyOnly = g.actions.every((a) => isReadonlyAction(a));

  const lines = [
    "ORACLE CONTROL GRANT (deterministic authorization)",
    "==================================================",
    row("Grant ID", id),
    row("Version", String(GRANT_VERSION)),
    row("Chain", String(g.chainId)),
    row("Agent", g.agentAddress),
    row("Account", g.accountAddress),
    row("Actions", g.actions.join(", ")),
    row("Targets", g.targets.length ? g.targets.join(", ") : "(none — read/simulate only)"),
    row("Max value", formatWei(g.maxValueWei)),
    row("Max gas", formatWei(g.maxGasWei)),
    row("Max slippage", formatBps(g.maxSlippageBps)),
    row("Expires", `${isoUtc(g.expiresAt)} (unix ${g.expiresAt})`),
    row("Nonce", g.nonce),
    row("Revocation", g.revocationKey),
    "--------------------------------------------------",
    readonlyOnly
      ? "Scope: read/simulate only — this grant cannot move funds."
      : "Scope: includes state-changing actions bounded by the caps above.",
    "Self-custodial: this grant contains public data only and can be revoked at any time via the revocation key.",
  ];
  return lines.join("\n");
}
