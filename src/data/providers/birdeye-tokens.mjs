// Birdeye public token list — Solana token rankings (no API key).
// Rate-limited public endpoint, light touch expected.

import { httpJson } from "../http.mjs";

export const BIRDEYE_PUBLIC = "https://public-api.birdeye.so";

function base(opts = {}) {
  return (opts.baseUrl || process.env.BIRDEYE_API_URL || BIRDEYE_PUBLIC).replace(/\/$/, "");
}

export async function birdeyeHealth(opts = {}) {
  try {
    const data = await httpJson(`${base(opts)}/public/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=1`, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
    return { ok: Array.isArray(data?.data) && data.data.length > 0, provider: "birdeye-tokens" };
  } catch (e) {
    return { ok: false, provider: "birdeye-tokens", error: String(e.message || e).slice(0, 120) };
  }
}

export async function birdeyeTokenList(args = {}, opts = {}) {
  const sortBy = String(args.sortBy || "v24hUSD");
  const sortType = String(args.sortType || "desc");
  const offset = Math.max(0, Number(args.offset || 0));
  const limit = Math.min(50, Math.max(1, Number(args.limit || 20)));
  return httpJson(`${base(opts)}/public/tokenlist?sort_by=${encodeURIComponent(sortBy)}&sort_type=${encodeURIComponent(sortType)}&offset=${offset}&limit=${limit}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}
