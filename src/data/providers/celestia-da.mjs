// Celestia DA — blob stats and transaction data via Celenium (no API key).

import { httpJson } from "../http.mjs";

export const CELENIUM_API = "https://api.celenium.io";

function base(opts = {}) {
  return (opts.baseUrl || process.env.CELENIUM_API_URL || CELENIUM_API).replace(/\/$/, "");
}

export async function celestiaHealth(opts = {}) {
  try {
    const data = await httpJson(`${base(opts)}/v1/stats`, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
    return { ok: data && data.blobs_count != null, provider: "celestia-da" };
  } catch (e) {
    return { ok: false, provider: "celestia-da", error: String(e.message || e).slice(0, 120) };
  }
}

export async function celestiaStats(opts = {}) {
  return httpJson(`${base(opts)}/v1/stats`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

export async function celestiaBlockStats(args = {}, opts = {}) {
  const height = Number(args.height);
  if (height && (!Number.isFinite(height) || height < 1)) throw new Error("celestia-da: height must be positive");
  const path = height ? `/v1/block/${height}` : "/v1/block";
  return httpJson(`${base(opts)}${path}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}
