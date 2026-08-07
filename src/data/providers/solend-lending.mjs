// Save (formerly Solend) — Solana lending markets and reserve rates.
//
// Solend rebranded to Save; api.solend.fi is retired and api.save.finance is
// the live surface. Read-only: market/reserve configuration and current
// supply/borrow APY. No deposit or borrow preparation lives here.

import { httpJson } from "../http.mjs";

export const SAVE_API = "https://api.save.finance";
// The canonical "main" pool — used as the health probe and the default market.
export const SAVE_MAIN_MARKET = "4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY";
export const SAVE_MAIN_MSOL_RESERVE = "CCpirWrgNuBVLdkP2haxLTbD6XqEgaYuVXixbbpxUB6";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function base(opts = {}) {
  return String(opts.baseUrl || process.env.SAVE_API_URL || process.env.SOLEND_API_URL || SAVE_API).replace(/\/$/, "");
}

function pubkey(value, label = "address") {
  const text = String(value ?? "").trim();
  if (!BASE58.test(text)) throw new Error(`solend-lending: ${label} must be a base58 public key`);
  return text;
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeMarket(market = {}) {
  return {
    address: market.address || null,
    name: market.name || null,
    description: market.description || "",
    isPrimary: Boolean(market.isPrimary),
    isPermissionless: Boolean(market.isPermissionless),
    hidden: Boolean(market.hidden),
    owner: market.owner || null,
    authorityAddress: market.authorityAddress || null,
    lookupTableAddress: market.lookupTableAddress || null,
    reserveCount: Array.isArray(market.reserves) ? market.reserves.length : 0,
    reserves: (market.reserves || []).map((r) => ({
      address: r.address || null,
      symbol: r.liquidityToken?.symbol || null,
      name: r.liquidityToken?.name || null,
      mint: r.liquidityToken?.mint || null,
      decimals: r.liquidityToken?.decimals ?? null,
      collateralMint: r.collateralMintAddress || null,
      pythOracle: r.pythOracle || null,
      switchboardOracle: r.switchboardOracle || null,
      volume24h: r.liquidityToken?.volume24h ?? null,
    })),
  };
}

function normalizeReserve(entry = {}) {
  const reserve = entry.reserve || {};
  const liquidity = reserve.liquidity || {};
  const collateral = reserve.collateral || {};
  return {
    address: entry.address || reserve.address || null,
    lendingMarket: reserve.lendingMarket || null,
    mint: liquidity.mintPubkey || null,
    mintDecimals: liquidity.mintDecimals ?? null,
    // Save returns these already as percentages ("26.38" = 26.38% APY).
    supplyApyPct: pct(entry.rates?.supplyInterest),
    borrowApyPct: pct(entry.rates?.borrowInterest),
    cTokenExchangeRate: entry.cTokenExchangeRate ?? null,
    availableAmount: liquidity.availableAmount ?? null,
    borrowedAmountWads: liquidity.borrowedAmountWads ?? null,
    marketPrice: liquidity.marketPrice ?? null,
    collateralMint: collateral.mintPubkey || null,
    collateralTotalSupply: collateral.mintTotalSupply ?? null,
    rewards: entry.rewards || [],
    lastUpdateSlot: reserve.lastUpdate?.slot ?? null,
    stale: reserve.lastUpdate?.stale === 1,
    raw: entry,
  };
}

export async function solendHealth(opts = {}) {
  try {
    const data = await httpJson(`${base(opts)}/v1/reserves?ids=${SAVE_MAIN_MSOL_RESERVE}`, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    return {
      ok: results.length > 0,
      provider: "solend-lending",
      probeReserve: SAVE_MAIN_MSOL_RESERVE,
      reserves: results.length,
      exec: false,
    };
  } catch (error) {
    return { ok: false, provider: "solend-lending", error: String(error?.message || error), exec: false };
  }
}

/**
 * List lending markets. Default scope returns the curated set; scope=all
 * includes every permissionless pool (200+, noticeably slower).
 */
export async function solendMarkets(args = {}, opts = {}) {
  const url = new URL(`${base(opts)}/v1/markets/configs`);
  if (args.scope) url.searchParams.set("scope", String(args.scope));
  if (args.deployment) url.searchParams.set("deployment", String(args.deployment));
  const data = await httpJson(url.toString(), {
    fetchImpl: opts.fetchImpl,
    // scope=all walks every permissionless pool and is genuinely slow upstream.
    timeoutMs: opts.timeoutMs ?? (args.scope === "all" ? 45_000 : 20_000),
  });
  let markets = (Array.isArray(data) ? data : []).map(normalizeMarket);
  if (args.includeHidden !== true) markets = markets.filter((m) => !m.hidden);
  if (args.name) {
    const want = String(args.name).toLowerCase();
    markets = markets.filter((m) => String(m.name || "").toLowerCase() === want);
  }
  const limit = Number(args.limit);
  if (Number.isFinite(limit) && limit > 0) markets = markets.slice(0, limit);
  return {
    provider: "solend-lending",
    chain: "solana-mainnet-beta",
    scope: args.scope || "default",
    count: markets.length,
    markets,
  };
}

/**
 * Current rates for reserves. Accepts explicit reserve addresses, or a market
 * address whose reserve set is resolved from the market config first.
 */
export async function solendReserves(args = {}, opts = {}) {
  let ids = [];
  if (args.ids || args.reserves) {
    const list = Array.isArray(args.ids || args.reserves) ? args.ids || args.reserves : String(args.ids || args.reserves).split(",");
    ids = list.map((v) => pubkey(String(v).trim(), "reserve"));
  } else {
    const market = pubkey(args.market || args.marketAddress || SAVE_MAIN_MARKET, "market");
    const config = await solendMarkets({ scope: "all", includeHidden: true }, opts);
    const found = config.markets.find((m) => m.address === market);
    if (!found) throw new Error(`solend-lending: market ${market} not found`);
    ids = found.reserves.map((r) => r.address).filter(Boolean);
  }
  if (!ids.length) throw new Error("solend-lending: no reserves to query");
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 50;
  ids = ids.slice(0, limit);

  const data = await httpJson(`${base(opts)}/v1/reserves?ids=${ids.join(",")}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 25_000,
  });
  const reserves = (Array.isArray(data?.results) ? data.results : []).map((entry, i) => ({
    ...normalizeReserve(entry),
    address: entry.address || entry.reserve?.address || ids[i] || null,
  }));
  return {
    provider: "solend-lending",
    chain: "solana-mainnet-beta",
    requested: ids.length,
    count: reserves.length,
    reserves,
  };
}
