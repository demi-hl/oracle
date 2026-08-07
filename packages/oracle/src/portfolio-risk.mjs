// Pure portfolio exposure and coverage summary. This module performs no I/O.

export const DEFAULT_RISK_THRESHOLDS = Object.freeze({
  assetHighPct: 50,
  assetMediumPct: 25,
  chainHighPct: 75,
  venueHighPct: 60,
  stablecoinHighPct: 70,
});

const STABLECOINS = new Set(["USDC", "USDT", "USDT0", "DAI", "FRAX", "LUSD", "TUSD", "USDP", "GUSD", "PYUSD", "USDE"]);

function finite(value) {
  if (value === null || value === "" || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function rounded(value) {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

function pct(value, total) {
  return total > 0 ? rounded((value / total) * 100) : null;
}

function addressOf(snapshot) {
  return snapshot.address || snapshot.owner || snapshot.walletAddress || snapshot.wallet?.address || null;
}

function labelIndex(labels) {
  const entries = Array.isArray(labels) ? labels : Array.isArray(labels?.entries) ? labels.entries : [];
  const index = new Map();
  for (const entry of entries) {
    if (!entry?.address) continue;
    const key = String(entry.address).toLowerCase();
    if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

function addAsset(output, raw, context = {}) {
  if (!raw || typeof raw !== "object") return;
  const symbol = String(raw.symbol ?? raw.coin ?? raw.name ?? raw.collection ?? raw.tokenId ?? "unknown");
  const value = finite(raw.usdValue ?? raw.valueUsd ?? raw.knownUsd ?? raw.estimatedValueUsd ?? raw.floorValueUsd);
  const kind = raw.kind === "nft" || raw.type === "nft" || raw.collection || raw.tokenId != null ? "nft" : "fungible";
  output.push({
    symbol,
    usdValue: value,
    chain: String(raw.chain ?? raw.chainName ?? context.chain ?? "unknown"),
    venue: String(raw.venue ?? raw.protocol ?? raw.platform ?? context.venue ?? "wallet"),
    address: raw.address ?? context.address ?? null,
    kind,
    stablecoin: raw.stablecoin === true || STABLECOINS.has(symbol.toUpperCase()),
  });
}

function assetsFromSnapshot(snapshot) {
  const output = [];
  const rootAddress = addressOf(snapshot);
  for (const asset of snapshot.assets || snapshot.holdings || []) addAsset(output, asset, { address: rootAddress, chain: snapshot.chain, venue: snapshot.venue });
  for (const chain of snapshot.chains || []) {
    const chainName = chain.chain ?? chain.name ?? chain.slug ?? (chain.chainId != null ? String(chain.chainId) : chain.family) ?? "unknown";
    const context = { address: chain.address ?? rootAddress, chain: chainName, venue: chain.venue };
    if (chain.native && (chain.native.amount == null || Number(chain.native.amount) !== 0)) {
      addAsset(output, { ...chain.native, symbol: chain.native.symbol ?? chain.symbol ?? chainName }, context);
    }
    for (const asset of chain.assets || chain.fungibleTokens?.assets || []) addAsset(output, asset, context);
    for (const asset of chain.collectibles?.assets || chain.nfts || []) addAsset(output, { ...asset, kind: "nft" }, context);
    for (const asset of chain.spot?.balances || []) addAsset(output, asset, { ...context, venue: "Hyperliquid spot" });
    const accountValue = finite(chain.perps?.accountValueUsd);
    if (accountValue != null) addAsset(output, { symbol: "perps account", usdValue: accountValue }, { ...context, venue: "Hyperliquid perps" });
  }
  for (const item of snapshot.inventory?.items || snapshot.nfts?.items || []) addAsset(output, { ...item, kind: "nft" }, { address: rootAddress, chain: item.chain ?? snapshot.chain, venue: item.marketplace ?? snapshot.venue });
  return output;
}

function snapshotKey(snapshot, index) {
  const address = addressOf(snapshot);
  const chain = snapshot.chain ?? snapshot.chainId ?? snapshot.family ?? "*";
  return address ? `${String(address).toLowerCase()}|${String(chain).toLowerCase()}` : `snapshot:${index}`;
}

function buckets(assets, property, total) {
  const map = new Map();
  for (const asset of assets) {
    if (asset.usdValue == null) continue;
    const name = asset[property];
    map.set(name, (map.get(name) || 0) + asset.usdValue);
  }
  return [...map].map(([name, knownUsd]) => ({ name, knownUsd: rounded(knownUsd), percentOfKnown: pct(knownUsd, total) }))
    .sort((a, b) => b.knownUsd - a.knownUsd || a.name.localeCompare(b.name));
}

/**
 * Summarize already-fetched portfolio snapshots. Accepts either
 * `{ snapshots, labels, thresholds }` or an array plus an options object.
 */
export function summarizePortfolioRisk(input = {}, options = {}) {
  const snapshots = Array.isArray(input) ? input : Array.isArray(input.snapshots) ? input.snapshots : input.snapshot ? [input.snapshot] : [];
  const labels = labelIndex(options.labels ?? options.addressBook ?? input.labels ?? input.addressBook);
  const thresholds = { ...DEFAULT_RISK_THRESHOLDS, ...(input.thresholds || {}), ...(options.thresholds || {}) };
  const unique = [];
  const seen = new Set();
  let duplicatesIgnored = 0;
  snapshots.forEach((snapshot, index) => {
    if (!snapshot || typeof snapshot !== "object") return;
    const key = snapshotKey(snapshot, index);
    if (seen.has(key)) duplicatesIgnored += 1;
    else { seen.add(key); unique.push(snapshot); }
  });

  const assets = unique.flatMap(assetsFromSnapshot);
  const priced = assets.filter((asset) => asset.usdValue != null);
  const unknown = assets.filter((asset) => asset.usdValue == null);
  const explicitUnknown = unique.reduce((sum, snapshot) => sum + Number(snapshot.valuation?.unpricedNonzeroItems || snapshot.unpricedNonzeroItems || 0), 0);
  const totalKnownUsd = rounded(priced.reduce((sum, asset) => sum + asset.usdValue, 0));
  const unknownItemCount = unknown.length + explicitUnknown;
  const chainExposures = buckets(priced, "chain", totalKnownUsd);
  const venueExposures = buckets(priced, "venue", totalKnownUsd);
  const groupedAssets = buckets(priced, "symbol", totalKnownUsd);
  for (const row of chainExposures) row.chain = row.name;
  for (const row of venueExposures) row.venue = row.name;
  for (const row of groupedAssets) {
    row.asset = row.name;
    row.symbol = row.name;
  }
  const stablecoinKnownUsd = rounded(priced.filter((asset) => asset.stablecoin).reduce((sum, asset) => sum + asset.usdValue, 0));
  const nftAssets = assets.filter((asset) => asset.kind === "nft");
  const snapshotNftUnvalued = unique.reduce((sum, snapshot) => sum + Number(snapshot.valuation?.nftUnvaluedItems || 0), 0);
  const nftUnvaluedItems = nftAssets.filter((asset) => asset.usdValue == null).length + snapshotNftUnvalued;
  const nftValuedItems = nftAssets.filter((asset) => asset.usdValue != null).length;
  const top = groupedAssets[0] || null;
  const concentrationLevel = !top ? "unknown" : top.percentOfKnown >= thresholds.assetHighPct ? "high" : top.percentOfKnown >= thresholds.assetMediumPct ? "medium" : "low";
  const warnings = [];
  if (unknownItemCount) warnings.push(`${unknownItemCount} nonzero holding(s) have unknown USD value; they are excluded from totals and percentages.`);
  if (nftUnvaluedItems) warnings.push("NFT valuation coverage is partial; estimates are not executable bids and unvalued NFTs are not treated as zero.");
  if (duplicatesIgnored) warnings.push(`${duplicatesIgnored} duplicate address/chain snapshot(s) were ignored.`);
  if (top && concentrationLevel !== "low") warnings.push(`Asset concentration is ${concentrationLevel}: ${top.name} is ${top.percentOfKnown}% of known value.`);
  if (chainExposures[0]?.percentOfKnown >= thresholds.chainHighPct) warnings.push(`Chain concentration is high: ${chainExposures[0].name} is ${chainExposures[0].percentOfKnown}% of known value.`);
  if (venueExposures[0]?.percentOfKnown >= thresholds.venueHighPct) warnings.push(`Venue concentration is high: ${venueExposures[0].name} is ${venueExposures[0].percentOfKnown}% of known value.`);

  const addresses = unique.map(addressOf).filter(Boolean).map((address) => {
    const entry = labels.get(String(address).toLowerCase());
    return { address, label: entry?.label ?? null, who: entry?.who ?? null, role: entry?.role ?? null };
  });
  return {
    totalKnownUsd,
    coverage: {
      complete: unique.length > 0 && unknownItemCount === 0 && unique.every((snapshot) => snapshot.valuation?.complete !== false && snapshot.coverage?.complete !== false),
      label: unknownItemCount === 0 && unique.length && unique.every((snapshot) => snapshot.valuation?.complete !== false && snapshot.coverage?.complete !== false)
        ? "complete for the supplied snapshots" : "known priced value only; portfolio coverage is partial or unverified",
      unknownUsd: unknownItemCount ? null : 0,
      pricedItemCount: priced.length,
      unknownItemCount,
      snapshotCount: unique.length,
      duplicatesIgnored,
    },
    chainExposures,
    venueExposures,
    topAssets: groupedAssets.slice(0, Math.max(1, Number(options.topAssets ?? input.topAssets ?? 10))),
    concentrationRisk: { level: concentrationLevel, topAsset: top?.name ?? null, topAssetPercent: top?.percentOfKnown ?? null, thresholds: { mediumPct: thresholds.assetMediumPct, highPct: thresholds.assetHighPct } },
    stablecoinExposure: { knownUsd: stablecoinKnownUsd, percentOfKnown: pct(stablecoinKnownUsd, totalKnownUsd), high: totalKnownUsd > 0 && pct(stablecoinKnownUsd, totalKnownUsd) >= thresholds.stablecoinHighPct },
    nftCoverage: { status: nftAssets.length || snapshotNftUnvalued ? (nftUnvaluedItems ? "partial" : "valued") : "not-observed", valuedItems: nftValuedItems, unvaluedItems: nftUnvaluedItems, knownUsd: rounded(nftAssets.filter((asset) => asset.usdValue != null).reduce((sum, asset) => sum + asset.usdValue, 0)) },
    addresses,
    warnings: [...new Set(warnings)],
  };
}

export const portfolioRiskSummary = summarizePortfolioRisk;
