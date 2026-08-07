// Pyth Hermes price feeds — keyless real-time Solana-native oracle reads.
//
// Hermes serves the same signed price updates Solana on-chain programs consume,
// so this is the price surface an operator should quote against when the
// counterparty is a Pyth-pulling program. Read-only: this module never returns
// the binary VAA as something executable, only the parsed price alongside it.

import { httpJson } from "../http.mjs";

export const PYTH_HERMES_API = "https://hermes.pyth.network";

// Well-known mainnet feed ids (hex, no 0x). Handy defaults for health + lookups.
export const PYTH_FEEDS = {
  "SOL/USD": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "BTC/USD": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH/USD": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "USDC/USD": "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  "USDT/USD": "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
  "JUP/USD": "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  "JTO/USD": "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
  "BONK/USD": "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
  "PYTH/USD": "0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff",
  "HYPE/USD": "4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b",
};

const FEED_ID_RE = /^[0-9a-fA-F]{64}$/;

function base(opts = {}) {
  return String(opts.baseUrl || process.env.PYTH_HERMES_URL || PYTH_HERMES_API).replace(/\/$/, "");
}

/**
 * Accept a raw hex feed id, an "0x"-prefixed id, or a symbol from PYTH_FEEDS.
 * Anything else is rejected rather than forwarded — a malformed id silently
 * drops out of the Hermes response and would otherwise look like a missing
 * price rather than a caller bug.
 */
export function pythFeedId(value, label = "feedId") {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`pyth-price-feeds: ${label} required`);
  const known = PYTH_FEEDS[raw.toUpperCase()] || PYTH_FEEDS[`${raw.toUpperCase()}/USD`];
  if (known) return known;
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!FEED_ID_RE.test(hex)) {
    throw new Error(`pyth-price-feeds: ${label} must be a 32-byte hex feed id or a known symbol`);
  }
  return hex.toLowerCase();
}

function scaled(component = {}) {
  const price = Number(component.price);
  const expo = Number(component.expo);
  if (!Number.isFinite(price) || !Number.isFinite(expo)) return null;
  return price * 10 ** expo;
}

function normalizeParsed(item = {}) {
  const conf = scaled({ price: Number(item.price?.conf), expo: item.price?.expo });
  const value = scaled(item.price);
  return {
    id: item.id || null,
    price: value,
    confidence: conf,
    // Confidence relative to price — the number that actually decides whether a
    // quote is safe to act on. A wide band means Pyth publishers disagree.
    confidenceBps: value && conf != null ? Math.round((conf / Math.abs(value)) * 10_000) : null,
    emaPrice: scaled(item.ema_price),
    publishTime: item.price?.publish_time ?? null,
    publishTimeIso: item.price?.publish_time ? new Date(item.price.publish_time * 1000).toISOString() : null,
    ageSeconds: item.price?.publish_time ? Math.max(0, Math.round(Date.now() / 1000 - item.price.publish_time)) : null,
    expo: item.price?.expo ?? null,
    raw: {
      price: item.price ?? null,
      emaPrice: item.ema_price ?? null,
      metadata: item.metadata ?? null,
    },
  };
}

async function fetchLatest(ids, opts = {}) {
  const url = new URL(`${base(opts)}/v2/updates/price/latest`);
  for (const id of ids) url.searchParams.append("ids[]", id);
  url.searchParams.set("encoding", "hex");
  url.searchParams.set("parsed", "true");
  // Without this a single retired id 400s the whole batch.
  url.searchParams.set("ignore_invalid_price_ids", "true");
  return httpJson(url.toString(), {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
}

export async function pythHealth(opts = {}) {
  try {
    const data = await fetchLatest([PYTH_FEEDS["SOL/USD"]], opts);
    const parsed = Array.isArray(data?.parsed) ? data.parsed.map(normalizeParsed) : [];
    const sol = parsed[0] || null;
    return {
      ok: Boolean(sol && Number.isFinite(sol.price) && sol.price > 0),
      provider: "pyth-price-feeds",
      solUsd: sol?.price ?? null,
      ageSeconds: sol?.ageSeconds ?? null,
      exec: false,
    };
  } catch (error) {
    return { ok: false, provider: "pyth-price-feeds", error: String(error?.message || error), exec: false };
  }
}

export async function pythLatestPrice(args = {}, opts = {}) {
  const id = pythFeedId(args.feedId || args.id || args.symbol, "feedId");
  const data = await fetchLatest([id], opts);
  const parsed = Array.isArray(data?.parsed) ? data.parsed.map(normalizeParsed) : [];
  const price = parsed.find((p) => String(p.id).toLowerCase() === id) || parsed[0] || null;
  if (!price) throw new Error(`pyth-price-feeds: no price returned for feed ${id}`);
  return {
    provider: "pyth-price-feeds",
    chain: "solana-mainnet-beta",
    feedId: id,
    ...price,
    // The signed update bytes an on-chain Pyth consumer would post. Surfaced
    // for inspection only — Oracle never submits it.
    binaryUpdate: data?.binary?.data?.[0] || null,
    binaryEncoding: data?.binary?.encoding || null,
  };
}

export async function pythLatestPrices(args = {}, opts = {}) {
  const list = Array.isArray(args) ? args : args.feedIds || args.ids || args.symbols || [];
  const ids = [...new Set(list.map((v) => pythFeedId(v, "feedIds[]")))];
  if (!ids.length) throw new Error("pyth-price-feeds: feedIds[] required");
  // Hermes caps a single query string; chunk so large batches still resolve.
  const CHUNK = 40;
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const responses = [];
  for (const chunk of chunks) responses.push(await fetchLatest(chunk, opts));
  const prices = responses.flatMap((data) => (Array.isArray(data?.parsed) ? data.parsed.map(normalizeParsed) : []));
  const byId = Object.fromEntries(prices.map((p) => [String(p.id).toLowerCase(), p]));
  return {
    provider: "pyth-price-feeds",
    chain: "solana-mainnet-beta",
    requested: ids.length,
    returned: prices.length,
    missing: ids.filter((id) => !byId[id]),
    prices,
    byId,
  };
}

export async function pythFeedDirectory(args = {}, opts = {}) {
  const url = new URL(`${base(opts)}/v2/price_feeds`);
  if (args.query) url.searchParams.set("query", String(args.query));
  url.searchParams.set("asset_type", String(args.assetType || "crypto"));
  const feeds = await httpJson(url.toString(), {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
  const list = Array.isArray(feeds) ? feeds : [];
  return {
    provider: "pyth-price-feeds",
    count: list.length,
    feeds: list.map((f) => ({
      id: f.id,
      symbol: f.attributes?.symbol || null,
      displaySymbol: f.attributes?.display_symbol || null,
      base: f.attributes?.base || null,
      quote: f.attributes?.quote_currency || null,
      assetType: f.attributes?.asset_type || null,
    })),
  };
}
