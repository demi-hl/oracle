import test from "node:test";
import assert from "node:assert/strict";
import { summarizePortfolioRisk } from "../src/portfolio-risk.mjs";

const ADDRESS = "0x000000000000000000000000000000000000dEaD";

test("summarizes chains, venues, assets, stablecoins, labels, and concentration", () => {
  const result = summarizePortfolioRisk({
    snapshots: [{ address: ADDRESS, chain: "ethereum", valuation: { complete: true }, assets: [
      { symbol: "ETH", usdValue: 800, venue: "wallet" },
      { symbol: "USDC", usdValue: 200, venue: "Aave" },
    ] }],
    addressBook: { entries: [{ address: ADDRESS.toLowerCase(), label: "treasury", role: "owner" }] },
  });
  assert.equal(result.totalKnownUsd, 1000);
  assert.deepEqual(result.chainExposures[0], { name: "ethereum", knownUsd: 1000, percentOfKnown: 100, chain: "ethereum" });
  assert.equal(result.venueExposures[0].name, "wallet");
  assert.equal(result.topAssets[0].symbol, "ETH");
  assert.equal(result.topAssets[0].name, "ETH");
  assert.equal(result.concentrationRisk.level, "high");
  assert.equal(result.stablecoinExposure.percentOfKnown, 20);
  assert.equal(result.addresses[0].label, "treasury");
});

test("missing prices stay unknown and never become zero-valued exposure", () => {
  const result = summarizePortfolioRisk([{ address: ADDRESS, chain: "base", assets: [
    { symbol: "ETH", usdValue: 50 },
    { symbol: "MYSTERY", amount: "12" },
  ] }]);
  assert.equal(result.totalKnownUsd, 50);
  assert.equal(result.coverage.unknownItemCount, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.topAssets.some((asset) => asset.name === "MYSTERY"), false);
  assert.match(result.warnings[0], /excluded from totals/);
  assert.equal(result.coverage.unknownUsd, null);
});

test("an empty input has unverified rather than complete coverage", () => {
  const result = summarizePortfolioRisk();
  assert.equal(result.coverage.complete, false);
  assert.equal(result.totalKnownUsd, 0);
});

test("partial NFT valuation is explicit", () => {
  const result = summarizePortfolioRisk({ snapshots: [{ address: ADDRESS, inventory: { items: [
    { collection: "Punks", tokenId: "1", chain: "ethereum", estimatedValueUsd: 100 },
    { collection: "Punks", tokenId: "2", chain: "ethereum" },
  ] } }] });
  assert.deepEqual(result.nftCoverage, { status: "partial", valuedItems: 1, unvaluedItems: 1, knownUsd: 100 });
  assert.match(result.warnings.join(" "), /not treated as zero/);
});

test("duplicate address and chain snapshots are ignored case-insensitively", () => {
  const snapshots = [
    { address: ADDRESS, chain: "ethereum", assets: [{ symbol: "ETH", usdValue: 100 }] },
    { address: ADDRESS.toLowerCase(), chain: "ETHEREUM", assets: [{ symbol: "ETH", usdValue: 100 }] },
  ];
  const result = summarizePortfolioRisk(snapshots);
  assert.equal(result.totalKnownUsd, 100);
  assert.equal(result.coverage.duplicatesIgnored, 1);
});

test("risk thresholds are configurable and medium boundary is inclusive", () => {
  const result = summarizePortfolioRisk({
    snapshots: [{ assets: [{ symbol: "A", usdValue: 40 }, { symbol: "B", usdValue: 60 }] }],
    thresholds: { assetHighPct: 80, assetMediumPct: 60 },
  });
  assert.equal(result.concentrationRisk.level, "medium");
  assert.equal(result.concentrationRisk.topAssetPercent, 60);
});
