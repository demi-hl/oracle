// Beefy Finance — cross-chain yield aggregator vaults (no API key).

import { httpJson } from "../http.mjs";

export const BEEFY_API = "https://api.beefy.finance";

function base(opts = {}) {
  return (opts.baseUrl || process.env.BEEFY_API_URL || BEEFY_API).replace(/\/$/, "");
}

export async function beefyHealth(opts = {}) {
  try {
    const data = await httpJson(`${base(opts)}/apy`, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
    const keys = Object.keys(data || {});
    return { ok: keys.length > 0, provider: "beefy-yields", vaultCount: keys.length };
  } catch (e) {
    return { ok: false, provider: "beefy-yields", error: String(e.message || e).slice(0, 120) };
  }
}

export async function beefyApy(args = {}, opts = {}) {
  const data = await httpJson(`${base(opts)}/apy`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  if (args.chain) {
    const prefix = String(args.chain).toLowerCase();
    const filtered = {};
    for (const [k, v] of Object.entries(data)) {
      if (String(k).toLowerCase().startsWith(prefix)) filtered[k] = v;
    }
    return filtered;
  }
  return data;
}

export async function beefyApyBreakdown(opts = {}) {
  return httpJson(`${base(opts)}/apy/breakdown`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 25_000,
  });
}
