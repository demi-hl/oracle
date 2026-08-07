import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutcomeCoin, outcomeAssetId, resolveHlAsset } from "../src/data/providers/hl-assets.mjs";
import { polyPrepareOrder } from "../src/data/providers/poly-clob.mjs";

test("HIP-4 encoding and asset id", () => {
  const a = outcomeAssetId(110, 0);
  assert.equal(a.encoding, 1100);
  assert.equal(a.coin, "#1100");
  assert.equal(a.assetId, 100_000_000 + 1100);
  const p = parseOutcomeCoin("#6741");
  assert.equal(p.outcome, 674);
  assert.equal(p.side, 1);
  assert.equal(p.assetId, 100_000_000 + 6741);
});

test("resolve HIP-3 builder coin asset id (live meta)", async () => {
  const info = await resolveHlAsset({ coin: "xyz:TSLA" });
  assert.equal(info.kind, "hip3");
  assert.equal(info.dex, "xyz");
  assert.ok(info.assetId >= 110000);
  assert.ok(info.szDecimals >= 0);
});

test("resolve main BTC still works", async () => {
  const info = await resolveHlAsset({ coin: "BTC" });
  assert.equal(info.kind, "main");
  assert.equal(info.assetId, 0);
});

test("polyPrepareOrder stamps envelope", () => {
  const wallet = "0x1111111111111111111111111111111111111111";
  const p = polyPrepareOrder({
    tokenId: "123456789",
    side: "BUY",
    price: 0.45,
    size: 10,
    maker: wallet,
    signer: wallet,
    signatureType: 0,
    tickSize: "0.01",
  });
  assert.equal(p.oraclePrepared, true);
  assert.equal(p.provider, "poly-clob");
  assert.equal(p.kind, "poly-order");
  assert.ok(p.value?.tokenId);
  assert.ok(p.domain?.verifyingContract);
});
