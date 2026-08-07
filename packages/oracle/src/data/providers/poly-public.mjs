// Polymarket public REST — CLOB + Gamma. No L2 API key, no wallet.

import { httpJson } from "../http.mjs";

export const POLY_CLOB_DEFAULT = "https://clob.polymarket.com";
export const POLY_GAMMA_DEFAULT = "https://gamma-api.polymarket.com";

function clobBase(opts = {}) {
  return (opts.clobUrl || process.env.POLY_CLOB_URL || POLY_CLOB_DEFAULT).replace(/\/$/, "");
}

function gammaBase(opts = {}) {
  return (opts.gammaUrl || process.env.POLY_GAMMA_URL || POLY_GAMMA_DEFAULT).replace(/\/$/, "");
}

export async function polyTime(opts = {}) {
  return httpJson(`${clobBase(opts)}/time`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function polyHealth(opts = {}) {
  const t = await polyTime(opts);
  const ok = t != null && t !== "";
  return { ok, time: t };
}

export async function polyMarkets({ limit = 5, offset = 0, ...rest } = {}, opts = {}) {
  const q = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    ...Object.fromEntries(
      Object.entries(rest)
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)])
    ),
  });
  return httpJson(`${gammaBase(opts)}/markets?${q}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function polyBook(tokenId, opts = {}) {
  if (!tokenId) throw new Error("polyBook requires tokenId");
  const q = new URLSearchParams({ token_id: String(tokenId) });
  return httpJson(`${clobBase(opts)}/book?${q}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function polyMidpoint(tokenId, opts = {}) {
  if (!tokenId) throw new Error("polyMidpoint requires tokenId");
  const q = new URLSearchParams({ token_id: String(tokenId) });
  return httpJson(`${clobBase(opts)}/midpoint?${q}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

// D1 expansions
export async function polySpread(tokenId, opts = {}) {
  if (!tokenId) throw new Error("polySpread requires tokenId");
  const q = new URLSearchParams({ token_id: String(tokenId) });
  return httpJson(`${clobBase(opts)}/spread?${q}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function polyPrice(tokenId, { side = "buy" } = {}, opts = {}) {
  if (!tokenId) throw new Error("polyPrice requires tokenId");
  const q = new URLSearchParams({ token_id: String(tokenId), side: String(side) });
  return httpJson(`${clobBase(opts)}/price?${q}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export async function polyEvents({ limit = 5, offset = 0, ...rest } = {}, opts = {}) {
  const q = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    ...Object.fromEntries(
      Object.entries(rest)
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)])
    ),
  });
  return httpJson(`${gammaBase(opts)}/events?${q}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}
