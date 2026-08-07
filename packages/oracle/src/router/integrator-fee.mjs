/**
 * Integrator fee policy.
 *
 * One place decides whether a route carries a fee, so the answer cannot drift
 * between providers. Three rules, in order:
 *
 *   1. OFF unless explicitly configured. No silent default skim.
 *   2. Locals Only holders pay ZERO. The NFT is the license; charging holders
 *      a per-swap fee on top would be selling the same access twice.
 *   3. Whatever is charged must be disclosable. `describeFee()` returns the
 *      exact bps and recipient so the caller can render it BEFORE the user
 *      signs. Oracle's pitch is "decoded before you sign" — an undisclosed fee
 *      would cost more credibility than the basis points are worth.
 *
 * Note on the status quo this replaces: LI.FI already applies its own 25 bps
 * to every route Oracle sends and keeps all of it, because Oracle never
 * identified itself as an integrator. Verified live 2026-08-06 — an
 * unregistered quote returns feeCosts [{ name: "LIFI Fixed Fee", percentage:
 * "0.0025" }]. So this is not a new cost to the user on that path; it is
 * Oracle claiming a share of a fee that is already being charged.
 */

const MAX_BPS = 100; // 1%. A hard ceiling so a typo cannot ship a 50% fee.

/**
 * 5 bps. Deliberately at the low end: LI.FI's own default is 25 bps and
 * Matcha runs 15, so this stays invisible to anyone comparison-shopping.
 *
 * The fee's job is not revenue maximisation — Locals Only holders pay zero, so
 * a small non-holder fee makes the NFT obviously worth holding. A large one
 * would just teach people to route around Oracle.
 */
export const DEFAULT_FEE_BPS = 5;

/**
 * Per-action pricing. A same-chain swap is the most price-shopped action in
 * crypto — every aggregator quotes it and users compare to the basis point —
 * so it stays cheapest. The others are not comparison-shopped the same way and
 * deliver more work per transaction.
 *
 *   swap     5 bps  below LI.FI 25 and Matcha 15
 *   bridge  15 bps  multi-chain routing, longer settlement, more failure modes
 *   perps    0      Hyperliquid builder fees are separate; never stack by default
 *   nft      0      marketplace fees are already heavy
 *
 * A holder pays zero on every one of these.
 */
export const FEE_TIERS = Object.freeze({
  swap: 5,
  bridge: 15,
  perps: 0,
  nft: 0,
});

export function tierBps(action) {
  const key = String(action || "swap").toLowerCase();
  return Object.prototype.hasOwnProperty.call(FEE_TIERS, key) ? FEE_TIERS[key] : DEFAULT_FEE_BPS;
}

export const FEE_ENV = "ORACLE_INTEGRATOR_FEE_BPS";
export const FEE_RECIPIENT_ENV = "ORACLE_INTEGRATOR_FEE_RECIPIENT";
export const INTEGRATOR_ENV = "ORACLE_INTEGRATOR_ID";

export const DEFAULT_INTEGRATOR_ID = "oracle";

function parseBps(raw, { fallback = 0 } = {}) {
  // Absent means "use the house default". An explicitly EMPTY string means the
  // operator set it to nothing on purpose, which is an instruction to charge
  // nothing — not an invitation to fall back.
  if (raw === undefined || raw === null) return fallback;
  if (String(raw).trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_BPS);
}

/**
 * Resolve the fee that applies to one route.
 *
 * `isHolder` is passed in rather than looked up here: this module must stay
 * synchronous and side-effect free so it can be called from inside quote
 * builders without turning them into async chain-readers.
 */
export function resolveFee({ env = process.env, isHolder = false, action = "swap" } = {}) {
  const recipient = String(env[FEE_RECIPIENT_ENV] || "").trim();
  // Setting a recipient is the opt-in. Once that exists, bps defaults to 5
  // rather than forcing every deployment to restate the house number.
  const bps = parseBps(env[FEE_ENV], { fallback: recipient ? tierBps(action) : 0 });
  const integrator = String(env[INTEGRATOR_ENV] || DEFAULT_INTEGRATOR_ID).trim();

  // Holder check comes first. A zero-bps tier (nft) would otherwise return
  // "not-configured" for a holder, which is a true zero with a misleading
  // reason — the UI would say "No Oracle fee" instead of crediting the NFT.
  if (isHolder) {
    return { bps: 0, recipient, integrator, action, applies: false, reason: "locals-only-holder" };
  }

  if (!bps) {
    return { bps: 0, recipient: "", integrator, action, applies: false, reason: "not-configured" };
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    // Fail closed. A fee with nowhere to go is a fee that silently vanishes
    // into the aggregator, which is the exact situation this module exists to
    // end.
    return { bps: 0, recipient: "", integrator, action, applies: false, reason: "no-recipient" };
  }
  return { bps, recipient, integrator, action, applies: true, reason: "configured" };
}

/** Human-readable disclosure. Render this next to the quote, before signing. */
export function describeFee(fee) {
  if (!fee?.applies) {
    if (fee?.reason === "locals-only-holder") return "No Oracle fee (Locals Only holder).";
    return "No Oracle fee.";
  }
  return `Oracle routing fee ${fee.bps} bps (${(fee.bps / 100).toFixed(2)}%) to ${fee.recipient}.`;
}

/** LI.FI wants a decimal fraction plus a registered integrator id. */
export function lifiFeeParams(fee) {
  if (!fee?.applies) return {};
  return { integrator: fee.integrator, fee: String(fee.bps / 10_000) };
}

/** ParaSwap wants integer bps and a partner string. */
export function paraswapFeeParams(fee) {
  if (!fee?.applies) return {};
  return {
    partner: fee.integrator,
    partnerFeeBps: String(fee.bps),
    partnerAddress: fee.recipient,
  };
}

export const FEE_MAX_BPS = MAX_BPS;
