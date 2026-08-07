// Across bridge — pool liquidity + APY per bridge pool (no API key).

import { httpJson } from "../http.mjs";

export const ACROSS_API = "https://app.across.to";

function base(opts = {}) {
  return (opts.baseUrl || process.env.ACROSS_API_URL || ACROSS_API).replace(/\/$/, "");
}

export async function acrossHealth(opts = {}) {
  try {
    const data = await httpJson(`${base(opts)}/api/pools?token=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
    return { ok: data && typeof data.totalPoolSize === "string", provider: "across-bridge", l1Token: data.l1Token };
  } catch (e) {
    return { ok: false, provider: "across-bridge", error: String(e.message || e).slice(0, 120) };
  }
}

export async function acrossPools(args = {}, opts = {}) {
  const token = String(args.l1Token || "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
  return httpJson(`${base(opts)}/api/pools?token=${encodeURIComponent(token)}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

export async function acrossSuggestedFees(args = {}, opts = {}) {
  const params = new URLSearchParams();
  if (args.originChainId) params.set("originChainId", String(args.originChainId));
  if (args.destinationChainId) params.set("destinationChainId", String(args.destinationChainId));
  if (args.token) params.set("token", String(args.token));
  if (args.amount) params.set("amount", String(args.amount));
  return httpJson(`${base(opts)}/api/suggested-fees?${params}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}
