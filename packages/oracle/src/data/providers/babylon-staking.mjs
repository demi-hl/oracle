// Babylon BTC staking — keyless read plane (staking-api.babylonlabs.io v2).
//
// Why this exists: Babylon is the largest native-BTC staking protocol, and its
// public v2 API answers the question Oracle actually needs — "what is THIS
// staker's BTC position?" — without a key, without an account, and without the
// user handing over anything but a public key.
//
// Verified live (v2):
//   GET /v2/stats                              200  APR / TVL / delegation counts
//   GET /v2/finality-providers                 200  FP roster + state + commission
//   GET /v2/delegations?staker_pk_hex=<pk>     200  per-staker positions (paginated)
//
// Read-only. No signing, no unbonding, no withdrawal. Staking actions are
// user-wallet operations and are deliberately absent from this module.

import { httpJson } from "../http.mjs";

export const BABYLON_STAKING_API = "https://staking-api.babylonlabs.io";

function baseUrl(opts = {}) {
  return String(opts.baseUrl || process.env.BABYLON_STAKING_API_URL || BABYLON_STAKING_API).replace(/\/$/, "");
}

function get(path, opts = {}) {
  return httpJson(`${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
    headers: { Accept: "application/json" },
  });
}

/**
 * Babylon identifies stakers and finality providers by 32-byte x-only BTC
 * public keys (64 hex chars). Accept the 33-byte compressed form too and drop
 * the parity byte, because that is what most wallets hand the user.
 */
export function babylonPkHex(value, label = "pkHex") {
  const text = String(value || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(text)) throw new Error(`babylon-staking: ${label} must be hex`);
  if (text.length === 66 && (text.startsWith("02") || text.startsWith("03"))) return text.slice(2);
  if (text.length !== 64) throw new Error(`babylon-staking: ${label} must be a 64-char x-only (or 66-char compressed) BTC public key`);
  return text;
}

export async function babylonHealth(opts = {}) {
  try {
    const res = await get("/v2/stats", opts);
    const data = res?.data || {};
    const tvl = Number(data.active_tvl ?? 0);
    return {
      ok: Number.isFinite(tvl) && tvl > 0,
      provider: "babylon-staking",
      baseUrl: baseUrl(opts),
      activeTvlSats: String(data.active_tvl ?? ""),
      activeFinalityProviders: data.active_finality_providers ?? null,
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "babylon-staking",
      baseUrl: baseUrl(opts),
      error: String(error?.message || error),
      exec: false,
    };
  }
}

/** Protocol-wide staking stats: TVL in sats, delegation counts, BTC staking APR. */
export async function babylonStats(_args = {}, opts = {}) {
  const res = await get("/v2/stats", opts);
  const d = res?.data || {};
  return {
    provider: "babylon-staking",
    activeTvlSats: String(d.active_tvl ?? ""),
    totalActiveTvlSats: String(d.total_active_tvl ?? ""),
    activeDelegations: d.active_delegations ?? null,
    totalActiveDelegations: d.total_active_delegations ?? null,
    activeFinalityProviders: d.active_finality_providers ?? null,
    totalFinalityProviders: d.total_finality_providers ?? null,
    // APRs arrive as fractions (0.00042 = 0.042%). Surface both so a caller
    // cannot silently render a fraction as a percent.
    btcStakingApr: d.btc_staking_apr ?? null,
    btcStakingAprPct: d.btc_staking_apr == null ? null : Number(d.btc_staking_apr) * 100,
    maxStakingApr: d.max_staking_apr ?? null,
    maxStakingAprPct: d.max_staking_apr == null ? null : Number(d.max_staking_apr) * 100,
    raw: d,
  };
}

/** Finality provider roster. Optional `state` filter, e.g. FINALITY_PROVIDER_STATUS_ACTIVE. */
export async function babylonFinalityProviders(args = {}, opts = {}) {
  const res = await get("/v2/finality-providers", opts);
  let rows = Array.isArray(res?.data) ? res.data : [];
  if (args.state) {
    const want = String(args.state).trim().toUpperCase();
    rows = rows.filter((r) => String(r.state || "").toUpperCase().includes(want));
  }
  if (args.btcPk) {
    const pk = babylonPkHex(args.btcPk, "btcPk");
    rows = rows.filter((r) => String(r.btc_pk || "").toLowerCase() === pk);
  }
  const limit = Math.min(500, Math.max(1, Number(args.limit || rows.length || 1)));
  return {
    provider: "babylon-staking",
    count: rows.length,
    finalityProviders: rows.slice(0, limit).map((r) => ({
      btcPk: r.btc_pk ?? null,
      moniker: r.description?.moniker ?? null,
      website: r.description?.website ?? null,
      state: r.state ?? null,
      commission: r.commission ?? null,
      activeTvlSats: r.active_tvl == null ? null : String(r.active_tvl),
      activeDelegations: r.active_delegations ?? null,
    })),
  };
}

/**
 * Per-staker BTC delegations. This is the keyless per-user position read: the
 * caller supplies only a PUBLIC key, so nothing here is custodial.
 */
export async function babylonDelegations(args = {}, opts = {}) {
  const stakerPk = babylonPkHex(args.stakerPkHex || args.stakerPk || args.pkHex || args.pk, "stakerPkHex");
  const params = new URLSearchParams({ staker_pk_hex: stakerPk });
  if (args.paginationKey) params.set("pagination_key", String(args.paginationKey));
  const res = await get(`/v2/delegations?${params}`, opts);
  const rows = Array.isArray(res?.data) ? res.data : [];
  const totalSats = rows.reduce((n, r) => n + Number(r.delegation_staking?.staking_amount ?? r.staking_amount ?? 0), 0);
  return {
    provider: "babylon-staking",
    stakerPkHex: stakerPk,
    count: rows.length,
    totalStakedSats: String(totalSats),
    nextKey: res?.pagination?.next_key || null,
    delegations: rows.map((r) => ({
      stakingTxHashHex: r.delegation_staking?.staking_tx_hash_hex ?? r.staking_tx_hash_hex ?? null,
      state: r.state ?? null,
      stakingAmountSats:
        r.delegation_staking?.staking_amount == null && r.staking_amount == null
          ? null
          : String(r.delegation_staking?.staking_amount ?? r.staking_amount),
      stakingTimelock: r.delegation_staking?.staking_timelock ?? null,
      startHeight: r.delegation_staking?.start_height ?? null,
      finalityProviderBtcPks: r.finality_provider_btc_pks_hex ?? null,
    })),
    raw: rows,
  };
}
