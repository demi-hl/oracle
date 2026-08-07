// D1–D3 data expansion tests (mocked).

import { test } from "node:test";
import assert from "node:assert/strict";
import { dataCatalog, dataCall, data } from "../src/data/desk-data.mjs";
import { resolveRpcUrl, rpcHealth, rpcGetBalance } from "../src/data/providers/evm-rpc.mjs";
import { llamaHealth, llamaPricesBySymbol } from "../src/data/providers/defillama.mjs";

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  };
}

test("D1 catalog includes evm-rpc + defillama and expanded ops", () => {
  const cat = dataCatalog();
  const ids = cat.map((p) => p.id).sort();
  assert.ok(ids.includes("evm-rpc"));
  assert.ok(ids.includes("defillama"));
  assert.ok(ids.includes("hl-info"));
  const hl = cat.find((p) => p.id === "hl-info");
  assert.ok(hl.ops.includes("meta"));
  const poly = cat.find((p) => p.id === "poly-public");
  assert.ok(poly.ops.includes("events"));
  const rh = cat.find((p) => p.id === "rh-agent");
  assert.ok(rh.ops.includes("chainConfig"));
});

test("D1 rh chainConfig via mock", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/chain/config")) return jsonResponse({ chainId: 4663 });
    return jsonResponse({});
  };
  const cfg = await data.rh.chainConfig({ fetchImpl });
  assert.equal(cfg.chainId, 4663);
});

test("D1 poly events via mock", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/events")) return jsonResponse([{ id: "e1" }]);
    return jsonResponse({});
  };
  const ev = await data.poly.events({ limit: 1 }, { fetchImpl });
  assert.equal(ev[0].id, "e1");
});

test("D2 resolveRpcUrl prefers env then public fallback", () => {
  const prev = process.env.ETH_RPC_URL;
  delete process.env.ETH_RPC_URL;
  assert.match(resolveRpcUrl(1), /publicnode|ethereum/i);
  process.env.ETH_RPC_URL = "https://custom.example/rpc";
  assert.equal(resolveRpcUrl(1), "https://custom.example/rpc");
  if (prev === undefined) delete process.env.ETH_RPC_URL;
  else process.env.ETH_RPC_URL = prev;
});

test("D2 rpcHealth mock", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "eth_blockNumber") return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x10" });
    if (body.method === "eth_chainId") return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" });
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: null });
  };
  const h = await rpcHealth(1, { fetchImpl, rpcUrl: "http://rpc.test" });
  assert.equal(h.ok, true);
  assert.equal(h.blockNumber, 16);
});

test("D2 getBalance mock", async () => {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.method, "eth_getBalance");
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }); // 1e18
  };
  const b = await rpcGetBalance(1, "0xabc", { fetchImpl, rpcUrl: "http://rpc.test" });
  assert.equal(b.balanceWei, "1000000000000000000");
});

test("D3 defillama health + pricesBySymbol mock", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("prices/current")) {
      return jsonResponse({
        coins: {
          "coingecko:ethereum": { price: 3000, symbol: "ETH" },
          "coingecko:bitcoin": { price: 60000, symbol: "BTC" },
        },
      });
    }
    return jsonResponse({});
  };
  const h = await llamaHealth({ fetchImpl });
  assert.equal(h.ok, true);
  assert.equal(h.ethUsd, 3000);
  const p = await llamaPricesBySymbol(["ethereum", "bitcoin"], { fetchImpl });
  assert.equal(p.bitcoin.price, 60000);
});

test("data.prices + data.rpc convenience", async () => {
  const fetchImpl = async (url, init) => {
    if (init?.method === "POST" && init.body) {
      const body = JSON.parse(init.body);
      if (body.method === "eth_blockNumber") return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x20" });
      if (body.method === "eth_chainId") return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" });
    }
    if (String(url).includes("prices")) {
      return jsonResponse({ coins: { "coingecko:ethereum": { price: 1 } } });
    }
    return jsonResponse({});
  };
  // override rpc via rpcUrl in opts — dataCall passes opts through
  const block = await dataCall("evm-rpc", "blockNumber", { chainId: 1 }, { fetchImpl, rpcUrl: "http://x" });
  assert.equal(block, 32);
  const ph = await data.prices.health({ fetchImpl });
  assert.equal(ph.ok, true);
});
