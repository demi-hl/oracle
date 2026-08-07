// Hyperliquid asset ID resolution — main perps, HIP-3 builder dexs, HIP-4 outcomes.
// Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
//
// Main perps:      asset = index in meta.universe
// HIP-3 builder:   asset = 100000 + perp_dex_index * 10000 + index_in_meta
// HIP-4 outcomes:  encoding = 10 * outcome + side; asset = 100_000_000 + encoding
//                  coin form: #<encoding>

import { hlInfo, hlMetaAndAssetCtxs } from "./hl-info.mjs";

const OUTCOME_ASSET_BASE = 100_000_000;
const BUILDER_PERP_BASE = 100_000;

let _dexCache = { at: 0, dexs: null };
let _metaCache = new Map(); // dex -> { at, universe, ctxs }

async function perpDexs(opts = {}) {
  const now = Date.now();
  if (_dexCache.dexs && now - _dexCache.at < 60_000 && !opts.fetchImpl) return _dexCache.dexs;
  const dexs = await hlInfo({ type: "perpDexs" }, opts);
  _dexCache = { at: now, dexs: Array.isArray(dexs) ? dexs : [] };
  return _dexCache.dexs;
}

async function metaForDex(dex = "", opts = {}) {
  const key = dex || "";
  const now = Date.now();
  const hit = _metaCache.get(key);
  // skip cache when caller injects fetchImpl (unit tests / custom transport)
  if (hit && now - hit.at < 30_000 && !opts.fetchImpl) return hit;
  const raw = dex
    ? await hlInfo({ type: "metaAndAssetCtxs", dex }, opts)
    : await hlMetaAndAssetCtxs(opts);
  const universe = raw?.[0]?.universe ?? raw?.universe ?? [];
  const ctxs = Array.isArray(raw?.[1]) ? raw[1] : [];
  const entry = { at: now, universe, ctxs };
  _metaCache.set(key, entry);
  return entry;
}

/** Parse HIP-4 coin "#1100" or encoding number → { encoding, outcome, side }. */
export function parseOutcomeCoin(coin) {
  const text = String(coin || "").trim();
  let encoding;
  if (text.startsWith("#")) encoding = Number(text.slice(1));
  else if (/^\d+$/.test(text)) encoding = Number(text);
  else return null;
  if (!Number.isInteger(encoding) || encoding < 0) return null;
  const side = encoding % 10;
  if (side !== 0 && side !== 1) return null;
  const outcome = Math.floor(encoding / 10);
  return { encoding, outcome, side, coin: `#${encoding}`, assetId: OUTCOME_ASSET_BASE + encoding };
}

export function outcomeAssetId(outcome, side) {
  const o = Number(outcome);
  const s = Number(side);
  if (!Number.isInteger(o) || o < 0) throw new Error("hl-assets: outcome id must be a non-negative integer");
  if (s !== 0 && s !== 1) throw new Error("hl-assets: outcome side must be 0 or 1");
  const encoding = 10 * o + s;
  return { encoding, outcome: o, side: s, coin: `#${encoding}`, assetId: OUTCOME_ASSET_BASE + encoding };
}

/**
 * Resolve any tradeable HL coin name to asset id + precision.
 * Accepts: "BTC", "xyz:TSLA", "#1100", { outcome, side }, { dex, coin }.
 */
export async function resolveHlAsset(args = {}, opts = {}) {
  // HIP-4 explicit
  if (args.outcome != null || (args.coin && String(args.coin).startsWith("#"))) {
    const parsed =
      args.outcome != null
        ? outcomeAssetId(args.outcome, args.side ?? args.outcomeSide ?? 0)
        : parseOutcomeCoin(args.coin);
    if (!parsed) throw new Error(`hl-assets: invalid outcome coin ${args.coin}`);
    // szDecimals for outcomes: typically 2-4; use 2 default (binary contracts)
    const szDecimals = args.szDecimals != null ? Number(args.szDecimals) : 2;
    return {
      kind: "outcome",
      coin: parsed.coin,
      assetId: parsed.assetId,
      encoding: parsed.encoding,
      outcome: parsed.outcome,
      side: parsed.side,
      szDecimals,
      maxLeverage: 1,
      dex: null,
      markPx: null,
    };
  }

  const rawName = String(args.coin || args.symbol || args.name || "").trim();
  if (!rawName) throw new Error("hl-assets: coin required");

  // HIP-3 builder dex coin: dex:COIN
  if (rawName.includes(":")) {
    const [dex, ...rest] = rawName.split(":");
    const leaf = rest.join(":");
    if (!dex || !leaf) throw new Error(`hl-assets: bad builder coin ${rawName}`);
    const dexs = await perpDexs(opts);
    const dexIndex = dexs.findIndex((d) => d && d.name === dex);
    if (dexIndex < 1) throw new Error(`hl-assets: unknown builder dex "${dex}"`);
    const { universe, ctxs } = await metaForDex(dex, opts);
    const index = universe.findIndex((a) => a.name === rawName || a.name === `${dex}:${leaf}` || a.name.endsWith(`:${leaf}`));
    if (index < 0) throw new Error(`hl-assets: ${rawName} not in dex ${dex} meta`);
    const asset = universe[index];
    if (asset.isDelisted) throw new Error(`hl-assets: ${rawName} is delisted`);
    const assetId = BUILDER_PERP_BASE + dexIndex * 10_000 + index;
    const ctx = ctxs[index] || {};
    return {
      kind: "hip3",
      coin: asset.name || rawName,
      assetId,
      szDecimals: asset.szDecimals ?? 0,
      maxLeverage: asset.maxLeverage ?? null,
      dex,
      dexIndex,
      indexInMeta: index,
      markPx: ctx.markPx ?? null,
    };
  }

  // Main dex perps
  const { universe, ctxs } = await metaForDex("", opts);
  const coin = rawName.toUpperCase();
  const index = universe.findIndex((a) => a.name === coin);
  if (index < 0) {
    // optional: bare leaf match on builder dexs (TSLA -> xyz:TSLA)
    if (opts.allowBareBuilderLeaf === true) {  // opt-in only; explicit dex:COIN preferred
      try {
        const dexs = await perpDexs(opts);
        for (let di = 1; di < dexs.length; di++) {
          const d = dexs[di];
          if (!d?.name) continue;
          const tryName = `${d.name}:${coin}`;
          try {
            return await resolveHlAsset({ coin: tryName }, opts);
          } catch {
            /* next dex */
          }
        }
      } catch {
        /* offline / mock without perpDexs */
      }
    }
    throw new Error(`hl-perps: ${coin} is not a listed perp`);
  }
  const asset = universe[index];
  if (asset.isDelisted) throw new Error(`hl-assets: ${coin} is delisted`);
  const ctx = ctxs[index] || {};
  return {
    kind: "main",
    coin: asset.name,
    assetId: index,
    szDecimals: asset.szDecimals ?? 0,
    maxLeverage: asset.maxLeverage ?? null,
    dex: "",
    markPx: ctx.markPx ?? null,
  };
}

export function clearHlAssetCache() {
  _dexCache = { at: 0, dexs: null };
  _metaCache.clear();
}
