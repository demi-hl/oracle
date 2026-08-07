// DexScreener public API — token/pair discovery, no key.

import { httpJson } from "../http.mjs";

export const DEXSCREENER_API = "https://api.dexscreener.com";

function base(opts = {}) {
  return (opts.baseUrl || process.env.DEXSCREENER_API_URL || DEXSCREENER_API).replace(/\/$/, "");
}

export async function dexscreenerHealth(opts = {}) {
  // tokenless root sometimes 404 — use a known stablecoin query
  const data = await httpJson(
    `${base(opts)}/latest/dex/search?q=USDC`,
    { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 12_000 }
  );
  const n = data?.pairs?.length || 0;
  return { ok: n > 0, pairSample: n };
}

export async function dexscreenerToken(tokenAddress, opts = {}) {
  if (!tokenAddress) throw new Error("tokenAddress required");
  return httpJson(`${base(opts)}/latest/dex/tokens/${tokenAddress}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
}

export async function dexscreenerSearch(q, opts = {}) {
  if (!q) throw new Error("query required");
  return httpJson(`${base(opts)}/latest/dex/search?q=${encodeURIComponent(q)}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
}

export async function dexscreenerPair(chainId, pairAddress, opts = {}) {
  if (!chainId || !pairAddress) throw new Error("chainId and pairAddress required");
  return httpJson(`${base(opts)}/latest/dex/pairs/${chainId}/${pairAddress}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
}
