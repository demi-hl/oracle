// Spark Lend / Sky Savings — ERC-4626 vault APY + market data (no API key).
// Read-only API exposing Spark and Sky Savings Vaults V2.

import { httpJson } from "../http.mjs";

export const SPARK_API = "https://api.spark.fi";

function base(opts = {}) {
  return (opts.baseUrl || process.env.SPARK_API_URL || SPARK_API).replace(/\/$/, "");
}

export async function sparkHealth(opts = {}) {
  try {
    // Probe the savings endpoint with a known vault
    const data = await httpJson(`${base(opts)}/v1/savings/spark/mainnet/usdc`, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 10_000,
    });
    return { ok: data?.data?.vault?.address != null, provider: "spark-lend" };
  } catch (e) {
    return { ok: false, provider: "spark-lend", error: String(e.message || e).slice(0, 120) };
  }
}

export async function sparkMarkets(args = {}, opts = {}) {
  const protocol = String(args.protocol || "spark");
  const chain = String(args.chain || "mainnet");
  const token = args.token ? String(args.token).toLowerCase() : null;

  if (token) {
    // Single vault: /v1/savings/{protocol}/{chain}/{token}
    return httpJson(`${base(opts)}/v1/savings/${encodeURIComponent(protocol)}/${encodeURIComponent(chain)}/${encodeURIComponent(token)}`, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
  }
  // All vaults for protocol + chain
  return httpJson(`${base(opts)}/v1/savings/${encodeURIComponent(protocol)}/${encodeURIComponent(chain)}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}
