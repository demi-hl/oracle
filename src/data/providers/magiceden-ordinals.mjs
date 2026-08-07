// Magic Eden ordinals market stats (api-mainnet.magiceden.dev/v2/ord/btc).
//
// UPSTREAM STATUS — measured, not assumed. As of the last verification pass
// EVERY call to this host returned:
//     HTTP 503  "no healthy upstream"
// across repeated attempts, on the keyless (.dev) host. The keyed host
// (api-mainnet.magiceden.us) answers 401 without a key, so the outage is on
// Magic Eden's side, not a local networking problem.
//
// This module is therefore wired as a BEST-EFFORT source that reports the
// outage honestly instead of masking it:
//   - health() returns ok:false with the real status while the upstream is
//     down. It does not report a green light for a dead endpoint.
//   - collectionStat() surfaces a typed `upstreamDown` result rather than
//     throwing an opaque HTTP error, so a caller can fall back to `satflow`
//     (Oracle's primary BTC NFT market provider) without special-casing text.
//
// SCOPE: only /v2/ord/btc/stat is wired. The other ord routes (collections,
// tokens, activities) were unreachable, so wiring them would be speculative.
//
// RATE LIMIT: Magic Eden documents 600 requests/minute (10 rps) on this API.
// http.mjs already honours Retry-After on 429.
//
// Read-only. No listing, no bidding, no PSBT construction here.

import { httpJson } from "../http.mjs";

export const MAGICEDEN_ORD_API = "https://api-mainnet.magiceden.dev/v2/ord/btc";
/** Documented ceiling: 600 req/min. */
export const MAGICEDEN_RATE_LIMIT_RPM = 600;

function baseUrl(opts = {}) {
  return String(opts.baseUrl || process.env.MAGICEDEN_ORD_API_URL || MAGICEDEN_ORD_API).replace(/\/$/, "");
}

function headers(opts = {}) {
  const h = { Accept: "application/json" };
  // Optional. The keyless .dev host needs no auth; a key is only meaningful
  // against the keyed host and is never required by this module.
  const key = opts.apiKey || process.env.MAGICEDEN_API_KEY;
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

export function collectionSymbol(value, label = "collectionSymbol") {
  const text = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(text)) {
    throw new Error(`magiceden-ordinals: ${label} must be a slug like "nodemonkes"`);
  }
  return text;
}

function get(path, opts = {}) {
  return httpJson(`${baseUrl(opts)}${path.startsWith("/") ? path : `/${path}`}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
    headers: headers(opts),
    // The upstream 503s are a hard outage, not transient congestion. Retrying
    // twice per call just multiplies latency during the outage window.
    retries: opts.retries ?? 1,
  });
}

/**
 * Probe the /stat route with a known collection. Reports the upstream's real
 * state — a 503 is surfaced as ok:false, never smoothed over.
 */
export async function magicEdenOrdHealth(opts = {}) {
  const probe = collectionSymbol(opts.probeCollection || process.env.MAGICEDEN_PROBE_COLLECTION || "nodemonkes");
  try {
    const stat = await get(`/stat?collectionSymbol=${encodeURIComponent(probe)}`, opts);
    return {
      ok: stat != null && typeof stat === "object",
      provider: "magiceden-ordinals",
      baseUrl: baseUrl(opts),
      probeCollection: probe,
      rateLimitRpm: MAGICEDEN_RATE_LIMIT_RPM,
      exec: false,
    };
  } catch (error) {
    const status = error?.status ?? null;
    return {
      ok: false,
      provider: "magiceden-ordinals",
      baseUrl: baseUrl(opts),
      probeCollection: probe,
      status,
      upstreamDown: status === 503 || status === 502 || status === 504,
      error: String(error?.message || error),
      fallback: "satflow",
      note:
        status === 503
          ? "Magic Eden ordinals API returned 503 'no healthy upstream'. Use the satflow provider for BTC NFT market data."
          : undefined,
      exec: false,
    };
  }
}

/**
 * Floor / volume / listed counts for one ordinals collection.
 * Returns { ok:false, upstreamDown:true } instead of throwing when Magic Eden
 * is unavailable, so a caller can degrade to satflow deterministically.
 */
export async function magicEdenOrdCollectionStat(args = {}, opts = {}) {
  const symbol = collectionSymbol(args.collectionSymbol || args.symbol || args.collection, "collectionSymbol");
  try {
    const s = await get(`/stat?collectionSymbol=${encodeURIComponent(symbol)}`, opts);
    const floorSats = s?.floorPrice == null ? null : Number(s.floorPrice);
    return {
      ok: true,
      provider: "magiceden-ordinals",
      collectionSymbol: symbol,
      floorPriceSats: floorSats == null ? null : String(s.floorPrice),
      floorPriceBtc: floorSats == null ? null : floorSats / 1e8,
      totalVolumeSats: s?.totalVolume == null ? null : String(s.totalVolume),
      totalVolumeBtc: s?.totalVolume == null ? null : Number(s.totalVolume) / 1e8,
      totalListed: s?.totalListed ?? null,
      owners: s?.owners ?? null,
      supply: s?.supply ?? null,
      pendingTransactions: s?.pendingTransactions ?? null,
      inscriptionNumberMin: s?.inscriptionNumberMin ?? null,
      inscriptionNumberMax: s?.inscriptionNumberMax ?? null,
      raw: s,
    };
  } catch (error) {
    const status = error?.status ?? null;
    const down = status === 502 || status === 503 || status === 504;
    if (!down) throw error;
    return {
      ok: false,
      provider: "magiceden-ordinals",
      collectionSymbol: symbol,
      status,
      upstreamDown: true,
      error: String(error?.message || error),
      fallback: "satflow",
      note: "Magic Eden ordinals API is returning 5xx ('no healthy upstream'). Query the satflow provider for floors and listings.",
    };
  }
}
