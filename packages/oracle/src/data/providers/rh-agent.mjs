// RH agent HTTP read client — talks to the live RH product over HTTP.
// Unauthenticated D0/D1 ops only. Does NOT import rhbot.

import { httpJson } from "../http.mjs";

export const RH_AGENT_DEFAULT_BASE = "http://127.0.0.1:8792";

function baseUrl(opts = {}) {
  return (
    opts.baseUrl ||
    process.env.RH_AGENT_BASE_URL ||
    process.env.RH_AGENT_URL ||
    RH_AGENT_DEFAULT_BASE
  ).replace(/\/$/, "");
}

async function get(path, opts = {}) {
  return httpJson(`${baseUrl(opts)}${path}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function rhHealth(opts = {}) {
  return get("/api/health", opts);
}

export async function rhPolicy(opts = {}) {
  return get("/api/agent/policy", opts);
}

// D1 — public RH routes (no requireUser)
export async function rhChainConfig(opts = {}) {
  return get("/api/chain/config", opts);
}

export async function rhChainGas(opts = {}) {
  return get("/api/chain/gas", opts);
}

export async function rhSwapsConfig(opts = {}) {
  return get("/api/swaps/config", opts);
}

export async function rhSwapsPresets(opts = {}) {
  return get("/api/swaps/presets", opts);
}

export async function rhTradingStatus(opts = {}) {
  return get("/api/trading/status", opts);
}

export async function rhNftDrops(opts = {}) {
  return get("/api/nft-drops", opts);
}

export async function rhFeeEstimate(opts = {}) {
  return get("/api/fee/estimate", opts);
}
