// Symbiotic restaking — vaults, collateral data, operator stats (no API key).

import { httpJson } from "../http.mjs";

export const SYMBIOTIC_API = "https://api.symbiotic.fi";

function base(opts = {}) {
  return (opts.baseUrl || process.env.SYMBIOTIC_API_URL || SYMBIOTIC_API).replace(/\/$/, "");
}

export async function symbioticHealth(opts = {}) {
  try {
    const data = await httpJson(`${base(opts)}/v1/vaults`, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
    return { ok: Array.isArray(data) && data.length > 0, provider: "symbiotic-restaking", count: data.length };
  } catch (e) {
    return { ok: false, provider: "symbiotic-restaking", error: String(e.message || e).slice(0, 120) };
  }
}

export async function symbioticVaults(args = {}, opts = {}) {
  const limit = Math.min(200, Math.max(1, Number(args.limit || 50)));
  const data = await httpJson(`${base(opts)}/v1/vaults?limit=${limit}&offset=${Math.max(0, Number(args.offset || 0))}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  // Filter by approved if requested
  if (args.approvedOnly) return data.filter((v) => v.approved === true);
  return data;
}

export async function symbioticVaultDetail(args = {}, opts = {}) {
  const address = String(args.address || "").trim();
  if (!address) throw new Error("symbiotic-restaking: address is required");
  return httpJson(`${base(opts)}/v1/vaults/${encodeURIComponent(address)}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}
