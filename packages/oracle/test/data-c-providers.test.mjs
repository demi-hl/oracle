// C: public DEX providers (mocked)

import { test } from "node:test";
import assert from "node:assert/strict";
import { dataCatalog, dataCall } from "../src/data/desk-data.mjs";
import { lifiQuote } from "../src/data/providers/lifi.mjs";
import { dexscreenerSearch } from "../src/data/providers/dexscreener.mjs";

test("catalog includes lifi + dexscreener", () => {
  const ids = dataCatalog().map((p) => p.id);
  assert.ok(ids.includes("lifi"));
  assert.ok(ids.includes("dexscreener"));
  assert.ok(ids.includes("hl-info"));
});

test("lifi quote mock", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return ({
    ok: true,
    text: async () =>
      JSON.stringify({
        type: "lifi",
        estimate: { toAmount: "1000", toAmountMin: "997" },
        transactionRequest: { to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" },
        action: { fromChainId: 8453, toChainId: 8453 },
      }),
    });
  };
  const q = await lifiQuote(
    {
      fromChain: 8453,
      toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      fromAmount: "1000000000000000",
    },
    { fetchImpl }
  );
  assert.equal(q.type, "lifi");
  assert.equal(q.autoSlippage.mode, "auto");
  assert.equal(q.autoSlippage.selectedBps, 30);
  assert.match(seen[0], /slippage=0\.003/);
  const via = await dataCall(
    "lifi",
    "quote",
    {
      fromChain: 8453,
      toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      fromAmount: "1",
    },
    { fetchImpl }
  );
  assert.equal(via.estimate.toAmount, "1000");
});

test("dexscreener search mock", async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({ pairs: [{ chainId: "base", pairAddress: "0xab" }] }),
  });
  const s = await dexscreenerSearch("USDC", { fetchImpl });
  assert.equal(s.pairs.length, 1);
});
