// Read-only NFT inventory and valuation coverage across configured wallet families.

import { mapLimit, timed } from "../http.mjs";
import { resolvePortfolioAddresses } from "./portfolio.mjs";
import { openseaAccountNfts, openseaAccountPnl, openseaPrepareList } from "./opensea-nft.mjs";
import { satflowWalletContents, satflowPrepareList } from "./satflow.mjs";
import { btcInscriptions } from "./bitcoin-meta.mjs";
import { magicEdenSolPrepareList } from "./magiceden-sol.mjs";
import { nftGallery } from "./nft-gallery.mjs";

export const OPENSEA_WALLET_CHAINS = Object.freeze([
  { chain: "ethereum", chainId: 1, family: "evm" },
  { chain: "optimism", chainId: 10, family: "evm" },
  { chain: "polygon", chainId: 137, family: "evm" },
  { chain: "stablechain", chainId: 988, family: "evm" },
  { chain: "hyperevm", chainId: 999, family: "evm" },
  { chain: "abstract", chainId: 2741, family: "evm" },
  { chain: "robinhood", chainId: 4663, family: "evm" },
  { chain: "base", chainId: 8453, family: "evm" },
  { chain: "arbitrum", chainId: 42161, family: "evm" },
  { chain: "avalanche", chainId: 43114, family: "evm" },
  { chain: "hyperliquid", chainId: null, family: "hyperliquid" },
]);

const KNOWN_UNSUPPORTED = Object.freeze([
  { family: "evm", chain: "bsc", chainId: 56, reason: "OpenSea account inventory does not support BSC" },
  { family: "cosmos", reason: "requires a chain-specific bech32 address and NFT indexer" },
  { family: "sui", reason: "owner inventory adapter not installed" },
  { family: "aptos", reason: "owner inventory adapter not installed" },
]);

function childOpts(opts = {}, key) {
  return {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    ...(opts[key] || {}),
  };
}

async function safe(label, fn) {
  const result = await timed(fn);
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: `${label}: ${result.error}`.slice(0, 300) };
}

function rowsFromSatflow(contents) {
  if (Array.isArray(contents)) return contents;
  for (const key of ["items", "results", "ordinals", "inscriptions", "data"]) {
    if (Array.isArray(contents?.[key])) return contents[key];
  }
  return [];
}

function normalizeSatflowItem(raw = {}, owner) {
  const inscriptionId = raw.inscription_id || raw.inscriptionId || raw.id || raw.inscription || null;
  return {
    chain: "bitcoin",
    family: "bitcoin",
    owner,
    contract: null,
    tokenId: inscriptionId == null ? null : String(inscriptionId),
    tokenStandard: "ordinal",
    collection: raw.collection_slug || raw.collectionSlug || raw.collection?.slug || raw.collection || null,
    name: raw.name || raw.meta?.name || (inscriptionId ? `Inscription ${inscriptionId}` : "Bitcoin inscription"),
    description: raw.description || raw.meta?.description || null,
    imageUrl: raw.image_url || raw.imageUrl || raw.content_url || raw.contentUrl || raw.thumbnail || null,
    originalImageUrl: raw.content_url || raw.contentUrl || raw.image_url || raw.imageUrl || null,
    animationUrl: null,
    metadataUrl: raw.metadata_url || raw.metadataUrl || null,
    marketplaceUrl: raw.marketplace_url || raw.marketplaceUrl || null,
    estimatedValueUsd: raw.estimated_value_usd != null && Number.isFinite(Number(raw.estimated_value_usd))
      ? Number(raw.estimated_value_usd)
      : null,
    estimatedValueSats: (raw.floor_price_sats ?? raw.price_sats) != null && Number.isFinite(Number(raw.floor_price_sats ?? raw.price_sats))
      ? Number(raw.floor_price_sats ?? raw.price_sats)
      : null,
    spam: false,
    disabled: false,
    nsfw: false,
    listed: raw.listed === true || raw.is_listed === true,
    listingId: raw.listing_id || raw.listingId || null,
    traits: Array.isArray(raw.traits) ? raw.traits : [],
    updatedAt: raw.updated_at || raw.updatedAt || null,
    acquisitionCost: null,
    itemPnl: {
      status: "unavailable",
      reason: "Satflow wallet inventory does not expose trustworthy acquisition cost",
    },
    listingAdapter: "satflow",
    source: "satflow-wallet-contents",
  };
}

function normalizeFallbackInscription(id, owner) {
  return {
    chain: "bitcoin",
    family: "bitcoin",
    owner,
    contract: null,
    tokenId: String(id),
    tokenStandard: "ordinal",
    collection: null,
    name: `Inscription ${id}`,
    description: null,
    imageUrl: null,
    originalImageUrl: null,
    animationUrl: null,
    metadataUrl: null,
    marketplaceUrl: null,
    estimatedValueUsd: null,
    spam: false,
    disabled: false,
    nsfw: false,
    traits: [],
    updatedAt: null,
    acquisitionCost: null,
    itemPnl: { status: "unavailable", reason: "address indexer returned no acquisition or valuation data" },
    listingAdapter: "satflow",
    source: "bitcoin-meta-address-indexer",
  };
}

export function nftAssetKey(item = {}) {
  return [item.chain || "unknown", item.contract || "native", item.tokenId || "unknown"].join(":").toLowerCase();
}

function costBasisMap(input) {
  const out = new Map();
  if (Array.isArray(input)) {
    for (const row of input) {
      if (row?.assetKey) out.set(String(row.assetKey).toLowerCase(), row);
    }
    return out;
  }
  if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(input)) out.set(key.toLowerCase(), value);
  }
  return out;
}

function applyCostBasis(item, basis) {
  const key = nftAssetKey(item);
  const row = basis.get(key);
  const current = item.estimatedValueUsd == null ? null : Number(item.estimatedValueUsd);
  if (!row) return { ...item, assetKey: key };
  const cost = Number(row.costUsd);
  const fees = Number(row.feesUsd ?? 0);
  if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(fees) || fees < 0) {
    return {
      ...item,
      assetKey: key,
      acquisitionCost: null,
      itemPnl: { status: "unavailable", reason: "invalid user-supplied cost basis" },
    };
  }
  const totalCostUsd = Math.round((cost + fees) * 100) / 100;
  if (!Number.isFinite(current)) {
    return {
      ...item,
      assetKey: key,
      acquisitionCost: {
        costUsd: cost,
        feesUsd: fees,
        totalCostUsd,
        acquiredAt: row.acquiredAt || null,
        source: row.source || "user-supplied",
      },
      itemPnl: { status: "unavailable", reason: "current NFT valuation is unavailable" },
    };
  }
  return {
    ...item,
    assetKey: key,
    acquisitionCost: {
      costUsd: cost,
      feesUsd: fees,
      totalCostUsd,
      acquiredAt: row.acquiredAt || null,
      source: row.source || "user-supplied",
    },
    itemPnl: {
      status: "estimated",
      methodology: "provider estimated current value minus supplied USD acquisition cost and fees",
      unrealizedUsd: Math.round((current - totalCostUsd) * 100) / 100,
      currentValueUsd: current,
      totalCostUsd,
      realizedUsd: null,
    },
  };
}

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    const key = nftAssetKey(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function pnlSummary(items, accountPnl) {
  const known = items.filter((item) => item.itemPnl?.status === "estimated");
  const unknown = items.length - known.length;
  const knownUnrealizedUsd = Math.round(
    known.reduce((sum, item) => sum + Number(item.itemPnl.unrealizedUsd || 0), 0) * 100,
  ) / 100;
  return {
    nftItemPnl: {
      status: unknown === 0 && items.length ? "estimated-complete-for-held-items" : known.length ? "partial" : "unavailable",
      methodology: "Only items with explicit acquisition cost and provider estimated current value are included",
      knownUnrealizedUsd,
      knownItems: known.length,
      unknownItems: unknown,
      realizedUsd: null,
      warning: "Transfers, gifts, airdrops, mints, bridges, gas, royalties, and off-market sales can make cost basis unavailable or incomplete.",
    },
    providerAccountPnl: accountPnl,
  };
}

/** One normalized owner NFT inventory with per-chain partial failure reporting. */
export async function nftHealth() {
  return {
    ok: true,
    provider: "nft-portfolio",
    readOnly: true,
    marketplaces: ["opensea", "magiceden-sol", "satflow"],
    listingExecution: "prepare-only",
  };
}

export async function nftInventory(args = {}, opts = {}) {
  const generatedAt = new Date().toISOString();
  const addresses = resolvePortfolioAddresses(args, opts.env || process.env);
  const selected = Array.isArray(args.chains) && args.chains.length
    ? new Set(args.chains.map((value) => String(value).toLowerCase()))
    : null;
  const openSeaChains = OPENSEA_WALLET_CHAINS.filter((row) => !selected || selected.has(row.chain));
  const coverage = [];
  const items = [];
  const openseaOpts = childOpts(opts, "opensea");

  const evmRows = addresses.evm
    ? openSeaChains.filter((row) => row.family !== "solana")
    : [];
  const evmResults = await mapLimit(evmRows, 4, async (row) => ({
    row,
    result: await safe(
      `opensea-${row.chain}`,
      () => openseaAccountNfts({
        chain: row.chain,
        address: addresses.evm,
        pageSize: args.pageSize,
        maxPages: args.maxPages,
      }, openseaOpts),
      opts.timeoutMs ?? 35_000,
    ),
  }));

  for (const { row, result } of evmResults) {
    if (result.ok) {
      const rows = result.data.nfts.map((item) => ({
        ...item,
        family: row.family,
        chainId: row.chainId,
        listingAdapter: "opensea",
        source: "opensea-account-inventory",
      }));
      items.push(...rows);
      coverage.push({
        family: row.family,
        chain: row.chain,
        chainId: row.chainId,
        status: result.data.complete ? "ok" : "partial",
        count: rows.length,
        complete: result.data.complete,
        next: result.data.next,
        source: "opensea",
      });
    } else {
      coverage.push({ family: row.family, chain: row.chain, chainId: row.chainId, status: "unavailable", error: result.error, source: "opensea" });
    }
  }

  if (!addresses.evm) {
    for (const row of openSeaChains.filter((item) => item.family !== "solana")) {
      coverage.push({ family: row.family, chain: row.chain, chainId: row.chainId, status: "not-configured", reason: "EVM address missing" });
    }
  }

  if (addresses.solana && (!selected || selected.has("solana"))) {
    const result = await safe(
      "opensea-solana",
      () => openseaAccountNfts({
        chain: "solana",
        address: addresses.solana,
        pageSize: args.pageSize,
        maxPages: args.maxPages,
      }, openseaOpts),
      opts.timeoutMs ?? 35_000,
    );
    if (result.ok) {
      const rows = result.data.nfts.map((item) => ({
        ...item,
        family: "solana",
        chainId: null,
        listingAdapter: null,
        source: "opensea-account-inventory",
      }));
      items.push(...rows);
      coverage.push({ family: "solana", chain: "solana", status: result.data.complete ? "ok" : "partial", count: rows.length, complete: result.data.complete, next: result.data.next, source: "opensea" });
    } else {
      coverage.push({ family: "solana", chain: "solana", status: "unavailable", error: result.error, source: "opensea" });
    }
  } else if (!selected || selected.has("solana")) {
    coverage.push({ family: "solana", chain: "solana", status: "not-configured", reason: "Solana address missing" });
  }

  if (addresses.bitcoin && (!selected || selected.has("bitcoin"))) {
    const satflow = await safe(
      "satflow-wallet-contents",
      () => satflowWalletContents({ address: addresses.bitcoin, type: "ordinals", limit: args.bitcoinLimit ?? 100, offset: 0 }, childOpts(opts, "satflow")),
      opts.timeoutMs ?? 35_000,
    );
    if (satflow.ok) {
      const rows = rowsFromSatflow(satflow.data.contents).map((item) => normalizeSatflowItem(item, addresses.bitcoin));
      items.push(...rows);
      const complete = rows.length < Number(args.bitcoinLimit ?? 100);
      coverage.push({ family: "bitcoin", chain: "bitcoin", status: complete ? "ok" : "partial", count: rows.length, complete, source: "satflow" });
    } else {
      const fallback = await safe(
        "bitcoin-meta-inscriptions",
        () => btcInscriptions({ address: addresses.bitcoin }, childOpts(opts, "bitcoinMeta")),
        opts.timeoutMs ?? 35_000,
      );
      const ids = fallback.ok && fallback.data?.ok && Array.isArray(fallback.data.inscriptions)
        ? fallback.data.inscriptions
        : [];
      items.push(...ids.map((id) => normalizeFallbackInscription(id, addresses.bitcoin)));
      coverage.push({
        family: "bitcoin",
        chain: "bitcoin",
        status: ids.length ? "partial" : "unavailable",
        count: ids.length,
        complete: false,
        source: ids.length ? "bitcoin-meta" : "satflow",
        error: ids.length ? "Satflow unavailable; fallback has IDs only" : satflow.error,
      });
    }
  } else if (!selected || selected.has("bitcoin")) {
    coverage.push({ family: "bitcoin", chain: "bitcoin", status: "not-configured", reason: "Bitcoin address missing" });
  }

  const accountPnl = [];
  if (args.includePnl !== false) {
    for (const address of [...new Set([addresses.evm, addresses.solana].filter(Boolean))]) {
      const result = await safe(
        `opensea-pnl-${address}`,
        () => openseaAccountPnl({ address }, openseaOpts),
        opts.timeoutMs ?? 35_000,
      );
      accountPnl.push(result.ok
        ? { status: "ok", ...result.data }
        : { status: "unavailable", address, source: "opensea-indexed-account-pnl", error: result.error });
    }
  }

  const basis = costBasisMap(args.costBasis);
  const normalized = dedupe(items).map((item) => applyCostBasis(item, basis));
  const visible = normalized.filter((item) => !item.spam);
  const flagged = normalized.filter((item) => item.spam);
  const estimated = visible.filter((item) =>
    item.estimatedValueUsd != null && Number.isFinite(Number(item.estimatedValueUsd)),
  );
  const estimatedCurrentValueUsd = Math.round(
    estimated.reduce((sum, item) => sum + Number(item.estimatedValueUsd), 0) * 100,
  ) / 100;
  const missingValueItems = visible.length - estimated.length;
  const failedCoverage = coverage.filter((row) => row.status !== "ok" || row.complete === false);

  return {
    provider: "nft-portfolio",
    operation: "inventory",
    readOnly: true,
    generatedAt,
    addresses,
    coverage,
    unsupported: KNOWN_UNSUPPORTED,
    inventory: {
      count: normalized.length,
      visibleCount: visible.length,
      flaggedCount: flagged.length,
      items: normalized,
      visibleItems: visible,
      flaggedItems: flagged,
    },
    valuation: {
      estimatedCurrentValueUsd,
      valuedItems: estimated.length,
      unvaluedItems: missingValueItems,
      complete: missingValueItems === 0 && failedCoverage.length === 0,
      methodology: "Sum of provider estimated_value_usd for non-flagged items. It is not an executable bid.",
    },
    pnl: pnlSummary(visible, accountPnl),
    listingCoverage: {
      opensea: "EVM listing actions available with OPENSEA_API_KEY, explicit price/currency/expiry, and user confirmation",
      satflow: "Bitcoin unsigned listing PSBT available with SATFLOW_API_KEY, explicit price/expiry, and user confirmation",
      solana: "Magic Eden unsigned list transaction available with MAGICEDEN_API_KEY, explicit SOL price/expiry, and user confirmation",
      unsupported: "Sui, Aptos, Cosmos, BSC, and unknown marketplaces fail closed",
    },
    metadataSafety: {
      imagesAreUntrusted: true,
      animationAndHtmlNotRendered: true,
      galleryRasterOnly: true,
      missingImagesUsePlaceholders: true,
    },
  };
}

function futureUnixSeconds(value, label) {
  const raw = typeof value === "number" ? value * 1000 : Date.parse(String(value || ""));
  if (!Number.isFinite(raw)) throw new Error(`${label} must be an ISO 8601 timestamp or Unix seconds`);
  const seconds = Math.floor(raw / 1000);
  if (seconds <= Math.floor(Date.now() / 1000)) throw new Error(`${label} must be in the future`);
  return seconds;
}

function positiveSats(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error("Bitcoin NFT list priceSats must be a positive integer");
  return text;
}

export async function nftPrepareList(args = {}, opts = {}) {
  if (args.userConfirmed !== true) {
    throw new Error("NFT listing preparation requires userConfirmed=true after reviewing asset, marketplace, price, currency, fees, royalties, and expiry");
  }
  const marketplace = String(args.marketplace || "").trim().toLowerCase();
  if (marketplace === "opensea") {
    return openseaPrepareList(args, childOpts(opts, "opensea"));
  }
  if (marketplace === "magiceden" || marketplace === "magiceden-sol") {
    const expiry = futureUnixSeconds(args.expiry ?? args.endTime, "Solana NFT listing expiry");
    return magicEdenSolPrepareList({ ...args, expiry }, childOpts(opts, "magiceden"));
  }
  if (marketplace === "satflow") {
    const expiry = futureUnixSeconds(args.expiry ?? args.endTime ?? args.expiresAt, "Bitcoin NFT listing expiry");
    return satflowPrepareList({
      inscription_id: args.inscriptionId || args.tokenId,
      runes_output: args.runesOutput,
      ord_address: args.ordAddress || args.seller,
      receive_address: args.receiveAddress,
      price: positiveSats(args.priceSats ?? args.price),
      tap_key: args.tapKey,
      collection_slug: args.collectionSlug || args.collection,
      expires_at: expiry,
    }, childOpts(opts, "satflow"));
  }
  throw new Error(`unsupported NFT marketplace: ${marketplace || "<missing>"}`);
}

export async function nftPnl(args = {}, opts = {}) {
  const inventory = await nftInventory({ ...args, includePnl: true }, opts);
  return {
    provider: "nft-portfolio",
    operation: "pnl",
    readOnly: true,
    generatedAt: inventory.generatedAt,
    addresses: inventory.addresses,
    coverage: inventory.coverage,
    unsupported: inventory.unsupported,
    valuation: inventory.valuation,
    pnl: inventory.pnl,
  };
}

export async function nftPortfolioGallery(args = {}, opts = {}) {
  let items = Array.isArray(args.items) ? args.items : null;
  let inventory = null;
  if (!items) {
    inventory = await nftInventory({ ...args, includePnl: false }, opts);
    items = inventory.inventory.visibleItems;
  }
  const gallery = await nftGallery({ ...args, items }, childOpts(opts, "gallery"));
  return {
    ...gallery,
    inventorySummary: inventory ? {
      visibleCount: inventory.inventory.visibleCount,
      flaggedCount: inventory.inventory.flaggedCount,
      coverage: inventory.coverage,
    } : null,
  };
}
