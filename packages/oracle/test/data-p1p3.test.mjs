// P1–P3 data providers (mocked unit tests)

import { test } from "node:test";
import assert from "node:assert/strict";
import { dataCatalog, dataCall } from "../src/data/desk-data.mjs";
import { acrossSuggestedFees, hopQuote, relayQuote } from "../src/data/providers/bridges.mjs";
import { cowQuote } from "../src/data/providers/cowswap.mjs";
import { zeroxHealth, zeroxQuote } from "../src/data/providers/zerox.mjs";
import { oneinchHealth, oneinchQuote } from "../src/data/providers/oneinch.mjs";
import { hlWsSnapshot } from "../src/data/providers/hl-ws.mjs";
import { polyWsSnapshot } from "../src/data/providers/poly-ws.mjs";

const EXPECTED = [
  "zerox",
  "across",
  "hop",
  "relay",
  "cowswap",
  "oneinch",
  "hl-ws",
  "poly-ws",
  "opensea-nft",
  "hyperevm-dex",
  "uniswap-v3",
];

test("catalog registers all P1-P3 providers", () => {
  const ids = dataCatalog().map((p) => p.id);
  for (const id of EXPECTED) assert.ok(ids.includes(id), `missing ${id}`);
});

test("zerox/oneinch health report unconfigured without keys", async () => {
  const z = await zeroxHealth({ apiKey: "" });
  assert.equal(z.configured, false);
  const o = await oneinchHealth({ apiKey: "" });
  assert.equal(o.configured, false);
});

test("across suggestedFees mock", async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({ estimatedFillTimeSec: 3, relayFeeTotal: "1" }),
  });
  const q = await acrossSuggestedFees(
    {
      token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      originChainId: 1,
      destinationChainId: 42161,
      amount: "1",
    },
    { fetchImpl }
  );
  assert.equal(q.estimatedFillTimeSec, 3);
});

test("hop + relay mocks via dataCall", async () => {
  const seen = {};
  const fetchImpl = async (url, init) => {
    if (String(url).includes("hop")) {
      seen.hop = String(url);
      return {
        ok: true,
        text: async () => JSON.stringify({ estimatedRecieved: "9", amountIn: "10" }),
      };
    }
    seen.relay = JSON.parse(init.body);
    return {
      ok: true,
      text: async () => JSON.stringify({ steps: [{ id: "deposit" }] }),
    };
  };
  const h = await hopQuote(
    { amount: "1", token: "ETH", fromChain: "ethereum", toChain: "arbitrum" },
    { fetchImpl }
  );
  assert.equal(h.estimatedRecieved, "9");
  assert.equal(h.autoSlippage.selectedBps, 50);
  assert.match(seen.hop, /slippage=0\.5/);
  const r = await relayQuote(
    { originChainId: 1, destinationChainId: 8453, amount: "1" },
    { fetchImpl }
  );
  assert.equal(r.steps[0].id, "deposit");
  assert.equal(r.autoSlippagePolicy.selectedBps, 50);
  assert.equal(seen.relay.slippageTolerance, "50");
});

test("cow quote mock", async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({ quote: { buyAmount: "1000", sellAmount: "900" } }),
  });
  const q = await cowQuote(
    {
      chainId: 1,
      sellToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      sellAmountBeforeFee: "1000",
    },
    { fetchImpl }
  );
  assert.equal(q.quote.buyAmount, "1000");
  assert.equal(q.autoSlippage.mode, "auto");
  assert.ok(q.autoSlippage.selectedBps <= 100);
});

test("0x and 1inch quotes expose bounded automatic output floors", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    const body = String(url).includes("mock-zerox")
      ? { buyAmount: "1000", transaction: { to: "0x111111125421ca6dc452d289314280a0f8842a65" } }
      : { dstAmount: "1000" };
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  const z = await zeroxQuote({
    chainId: 8453,
    sellToken: "0x4200000000000000000000000000000000000006",
    buyToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    sellAmount: "1",
  }, { fetchImpl, apiKey: "test", baseUrl: "https://mock-zerox.test" });
  assert.equal(z.autoSlippage.mode, "auto");
  assert.match(seen[0], /slippageBps=30/);

  const o = await oneinchQuote({
    chainId: 8453,
    src: "0x4200000000000000000000000000000000000006",
    dst: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    amount: "1",
  }, { fetchImpl, apiKey: "test", baseUrl: "https://mock.1inch" });
  assert.equal(o.autoSlippage.mode, "auto");
  assert.ok(o.autoSlippage.selectedBps <= 100);
});

/** Minimal WebSocket mock */
class MockWS {
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.listeners = {};
    queueMicrotask(() => this.listeners.open?.forEach((fn) => fn()));
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }
  send(msg) {
    const sub = JSON.parse(msg);
    const payload =
      sub.method === "subscribe"
        ? { channel: "allMids", data: { mids: { BTC: "1" } } }
        : { asset_id: "x", bids: [], asks: [] };
    queueMicrotask(() =>
      this.listeners.message?.forEach((fn) => fn({ data: JSON.stringify(payload) }))
    );
  }
  close() {}
}

test("hl-ws snapshot with MockWS", async () => {
  const snap = await hlWsSnapshot(
    { type: "allMids" },
    { WebSocket: MockWS, timeoutMs: 2000 }
  );
  assert.equal(snap.ok, true);
  assert.ok(snap.last?.data?.mids || snap.messages.length);
});

test("poly-ws snapshot with MockWS", async () => {
  const snap = await polyWsSnapshot(["123"], { WebSocket: MockWS, timeoutMs: 2000 });
  assert.equal(snap.ok, true);
});

test("dataCall hyperevm-dex.search mock", async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        pairs: [{ chainId: "hyperliquid", pairAddress: "0xabc", baseToken: { symbol: "HYPE" } }],
      }),
  });
  const s = await dataCall("hyperevm-dex", "search", { q: "HYPE" }, { fetchImpl });
  assert.ok(s.count >= 1);
});
