// DeFiLlama public prices — protocol pack D3 (no API key).

import { httpJson } from "../http.mjs";

export const DEFILLAMA_COINS = "https://coins.llama.fi";
export const DEFILLAMA_API = "https://api.llama.fi";
export const DEFILLAMA_YIELDS = "https://yields.llama.fi";
export const DEFILLAMA_STABLECOINS = "https://stablecoins.llama.fi";

function coinsBase(opts = {}) {
  return (opts.baseUrl || process.env.DEFILLAMA_COINS_URL || DEFILLAMA_COINS).replace(/\/$/, "");
}

function apiBase(opts = {}) {
  return (opts.baseUrl || process.env.DEFILLAMA_API_URL || DEFILLAMA_API).replace(/\/$/, "");
}

/** @param {string[]} coins e.g. ['coingecko:ethereum','coingecko:bitcoin'] */
export async function llamaPrices(coins, opts = {}) {
  if (!Array.isArray(coins) || !coins.length) throw new Error("llamaPrices requires coins[]");
  const path = coins.map(encodeURIComponent).join(",");
  return httpJson(`${coinsBase(opts)}/prices/current/${path}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function llamaHealth(opts = {}) {
  const data = await llamaPrices(["coingecko:ethereum"], opts);
  const eth = data?.coins?.["coingecko:ethereum"];
  return { ok: !!eth?.price, ethUsd: eth?.price ?? null };
}

export async function llamaProtocols(opts = {}) {
  return httpJson(`${apiBase(opts)}/protocols`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

export async function llamaYields(args = {}, opts = {}) {
  const base = (opts.yieldsBaseUrl || process.env.DEFILLAMA_YIELDS_URL || DEFILLAMA_YIELDS).replace(/\/$/, "");
  const result = await httpJson(`${base}/pools`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  let rows = Array.isArray(result?.data) ? result.data : [];
  if (args.chain) rows = rows.filter((x) => String(x.chain).toLowerCase() === String(args.chain).toLowerCase());
  if (args.project) rows = rows.filter((x) => String(x.project).toLowerCase() === String(args.project).toLowerCase());
  if (args.stablecoin != null) rows = rows.filter((x) => Boolean(x.stablecoin) === Boolean(args.stablecoin));
  rows.sort((a, b) => Number(b.tvlUsd || 0) - Number(a.tvlUsd || 0));
  const limit = Math.min(5000, Math.max(1, Number(args.limit || rows.length || 1)));
  return { ...result, data: rows.slice(0, limit) };
}

export async function llamaStablecoins(args = {}, opts = {}) {
  const base = (opts.stablecoinsBaseUrl || process.env.DEFILLAMA_STABLECOINS_URL || DEFILLAMA_STABLECOINS).replace(/\/$/, "");
  const includePrices = args.includePrices !== false;
  return httpJson(`${base}/stablecoins?includePrices=${includePrices}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
}

export async function llamaDexVolumes(args = {}, opts = {}) {
  const chain = encodeURIComponent(String(args.chain || "Ethereum"));
  const params = new URLSearchParams({
    excludeTotalDataChart: String(args.includeChart !== true),
    excludeTotalDataChartBreakdown: String(args.includeBreakdown !== true),
    dataType: "dailyVolume",
  });
  return httpJson(`${apiBase(opts)}/overview/dexs/${chain}?${params}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
}

/** Convenience: map symbols via coingecko ids */
export async function llamaPricesBySymbol(symbols = ["ethereum", "bitcoin", "solana"], opts = {}) {
  const coins = symbols.map((s) => `coingecko:${String(s).toLowerCase()}`);
  const data = await llamaPrices(coins, opts);
  const out = {};
  for (const s of symbols) {
    const key = `coingecko:${String(s).toLowerCase()}`;
    out[s] = data?.coins?.[key] || null;
  }
  return out;
}
