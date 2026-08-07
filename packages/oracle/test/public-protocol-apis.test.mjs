import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";

import { dataCall, dataCatalog } from "../src/data/desk-data.mjs";
import { erc20Allowance, erc20BalanceOf, transactionReceipt } from "../src/data/providers/evm-rpc.mjs";
import { geckoNetworks, geckoPoolOhlcv } from "../src/data/providers/geckoterminal.mjs";
import { curvePools } from "../src/data/providers/curve.mjs";
import { gmxTickers } from "../src/data/providers/gmx.mjs";
import { morphoMarkets } from "../src/data/providers/morpho.mjs";
import { balancerPools } from "../src/data/providers/balancer.mjs";
import { pendleMarkets } from "../src/data/providers/pendle.mjs";
import { odosChains } from "../src/data/providers/odos.mjs";
import { blockscoutStats } from "../src/data/providers/blockscout.mjs";
import { paraswapPrice } from "../src/data/providers/paraswap.mjs";
import { buildPublicApiCoverage } from "../src/data/public-api-scan.mjs";

function response(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
  };
}

const ERC20 = new Interface([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

test("catalog registers the public protocol API expansion", () => {
  const ids = new Set(dataCatalog().map((p) => p.id));
  for (const id of [
    "geckoterminal",
    "curve",
    "gmx",
    "morpho",
    "balancer",
    "pendle",
    "odos",
    "blockscout",
    "paraswap",
  ]) assert.ok(ids.has(id), `missing ${id}`);
});

test("GeckoTerminal exposes networks and pool OHLCV without a key", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes("ohlcv")) return response({ data: { attributes: { ohlcv_list: [[1,2,3,4,5,6]] } } });
    return response({ data: [{ id: "base", type: "network" }] });
  };
  const networks = await geckoNetworks({ page: 1 }, { fetchImpl });
  assert.equal(networks.data[0].id, "base");
  const bars = await geckoPoolOhlcv({ network: "base", poolAddress: "0xabc", timeframe: "hour", limit: 24 }, { fetchImpl });
  assert.equal(bars.data.attributes.ohlcv_list.length, 1);
  assert.match(seen[1], /networks\/base\/pools\/0xabc\/ohlcv\/hour/);
  assert.match(seen[1], /limit=24/);
});

test("DeFiLlama expanded public surfaces route through dataCall", async () => {
  const fetchImpl = async (url) => {
    const s = String(url);
    if (s.includes("yields")) return response({ status: "success", data: [{ chain: "Base" }] });
    if (s.includes("stablecoins")) return response({ peggedAssets: [{ symbol: "USDC" }] });
    return response({ protocols: [{ name: "Aerodrome" }] });
  };
  const yields = await dataCall("defillama", "yields", { chain: "Base", limit: 10 }, { fetchImpl });
  assert.equal(yields.data.length, 1);
  const stables = await dataCall("defillama", "stablecoins", {}, { fetchImpl });
  assert.equal(stables.peggedAssets[0].symbol, "USDC");
  const dex = await dataCall("defillama", "dexVolumes", { chain: "Base" }, { fetchImpl });
  assert.equal(dex.protocols[0].name, "Aerodrome");
});

test("Curve and GMX expose protocol-native public market data", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes("curve")) return response({ success: true, data: { poolData: [{ address: "0xpool" }] } });
    return response([{ tokenSymbol: "ETH", minPrice: "1", maxPrice: "2" }]);
  };
  const pools = await curvePools({ chain: "arbitrum", registry: "main" }, { fetchImpl });
  assert.equal(pools.data.poolData[0].address, "0xpool");
  const tickers = await gmxTickers({ chainId: 42161 }, { fetchImpl });
  assert.equal(tickers[0].tokenSymbol, "ETH");
  assert.match(seen[0], /getPools\/arbitrum\/main/);
  assert.match(seen[1], /arbitrum-api\.gmxinfra\.io\/prices\/tickers/);
});

test("Morpho and Balancer GraphQL clients send bounded chain-filtered queries", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return response({ data: { markets: { items: [{ marketId: "0xmarket" }] } } });
    return response({ data: { poolGetPools: [{ id: "0xpool", chain: "BASE" }] } });
  };
  const markets = await morphoMarkets({ chainId: 8453, first: 2 }, { fetchImpl });
  assert.equal(markets.data.markets.items[0].marketId, "0xmarket");
  assert.deepEqual(bodies[0].variables.chainIds, [8453]);
  assert.equal(bodies[0].variables.first, 2);
  const pools = await balancerPools({ chains: ["BASE"], first: 3 }, { fetchImpl });
  assert.equal(pools.data.poolGetPools[0].id, "0xpool");
  assert.deepEqual(bodies[1].variables.chains, ["BASE"]);
});

test("Pendle, Odos, and Blockscout expose live chain discovery surfaces", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes("pendle")) return response({ total: 1, results: [{ chainId: 42161 }] });
    if (String(url).includes("odos")) return response({ chains: [1, 8453, 42161] });
    return response({ total_blocks: "123" });
  };
  const markets = await pendleMarkets({ chainId: 42161, limit: 1 }, { fetchImpl });
  assert.equal(markets.total, 1);
  const chains = await odosChains({ fetchImpl });
  assert.ok(chains.chains.includes(8453));
  const stats = await blockscoutStats({ chainId: 8453 }, { fetchImpl });
  assert.equal(stats.total_blocks, "123");
  assert.match(seen[0], /core\/v1\/42161\/markets/);
  assert.match(seen[2], /base\.blockscout\.com\/api\/v2\/stats/);
  await assert.rejects(() => blockscoutStats({ chainId: 999 }, { fetchImpl }), /not configured/);
});

test("ParaSwap exposes a keyless quote-only price route with an automatic floor", async () => {
  let seen;
  const fetchImpl = async (url) => {
    seen = String(url);
    return response({ priceRoute: { network: 1, srcAmount: "1000", destAmount: "2000" } });
  };
  const quote = await paraswapPrice({
    chainId: 1,
    srcToken: "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    destToken: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
    amount: "1000",
    srcDecimals: 18,
    destDecimals: 6,
  }, { fetchImpl });
  assert.equal(quote.autoSlippage.mode, "auto");
  assert.equal(quote.autoSlippage.capBps, 100);
  assert.match(seen, /network=1/);
  assert.match(seen, /destToken=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/);
});

test("evm-rpc reads ERC20 allowance with a canonical eth_call", async () => {
  let body;
  const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const owner = "0x00000000000000000000000000000000000A1ce5";
  const spender = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
  const fetchImpl = async (_url, init = {}) => {
    body = JSON.parse(init.body);
    return response({ jsonrpc: "2.0", id: body.id, result: ERC20.encodeFunctionResult("allowance", [1234n]) });
  };
  const result = await erc20Allowance({ chainId: 8453, token, owner, spender }, { fetchImpl, rpcUrl: "http://rpc.local" });
  assert.equal(result.allowance, "1234");
  assert.equal(result.chainId, 8453);
  assert.equal(result.token, token.toLowerCase());
  assert.equal(body.method, "eth_call");
  assert.equal(body.params[0].to, token.toLowerCase());
  const decoded = ERC20.decodeFunctionData("allowance", body.params[0].data);
  assert.equal(decoded.owner, owner);
  assert.equal(decoded.spender.toLowerCase(), spender);
  const routed = await dataCall("evm-rpc", "erc20Allowance", { chainId: 8453, token, owner, spender }, { fetchImpl, rpcUrl: "http://rpc.local" });
  assert.equal(routed.allowance, "1234");
});

test("evm-rpc reads transaction receipts and ERC20 balances for post-broadcast verification", async () => {
  const txHash = `0x${"1".repeat(64)}`;
  const pendingHash = `0x${"0".repeat(64)}`;
  const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const account = "0x00000000000000000000000000000000000A1ce5";
  const router = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
  const seen = [];
  const fetchImpl = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    if (body.method === "eth_getTransactionReceipt") {
      if (body.params[0] === pendingHash) return response({ jsonrpc: "2.0", id: body.id, result: null });
      return response({ jsonrpc: "2.0", id: body.id, result: {
        transactionHash: body.params[0],
        status: "0x1",
        to: router,
        from: account,
        blockNumber: "0x10",
        transactionIndex: "0x0",
        logs: [],
      } });
    }
    if (body.method === "eth_call") {
      return response({ jsonrpc: "2.0", id: body.id, result: ERC20.encodeFunctionResult("balanceOf", [1234n]) });
    }
    throw new Error(`unexpected rpc method ${body.method}`);
  };
  const receipt = await transactionReceipt({ chainId: 8453, txHash, expectedTo: router }, { fetchImpl, rpcUrl: "http://rpc.local" });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.status, "success");
  assert.equal(receipt.blockNumber, 16);
  const wrongTo = await transactionReceipt({ chainId: 8453, txHash, expectedTo: token }, { fetchImpl, rpcUrl: "http://rpc.local" });
  assert.equal(wrongTo.ok, false);
  assert.match(wrongTo.reason, /to mismatch/);
  const pending = await transactionReceipt({ chainId: 8453, txHash: pendingHash }, { fetchImpl, rpcUrl: "http://rpc.local" });
  assert.equal(pending.ok, false);
  assert.equal(pending.status, "pending");
  const balance = await erc20BalanceOf({ chainId: 8453, token, account }, { fetchImpl, rpcUrl: "http://rpc.local" });
  assert.equal(balance.balance, "1234");
  assert.equal(balance.token, token);
  const routedReceipt = await dataCall("evm-rpc", "transactionReceipt", { chainId: 8453, txHash, expectedTo: router }, { fetchImpl, rpcUrl: "http://rpc.local" });
  assert.equal(routedReceipt.ok, true);
  const routedBalance = await dataCall("evm-rpc", "erc20Balance", { chainId: 8453, token, account }, { fetchImpl, rpcUrl: "http://rpc.local" });
  assert.equal(routedBalance.balance, "1234");
  assert.ok(seen.some((body) => body.method === "eth_getTransactionReceipt"));
  assert.ok(seen.some((body) => body.method === "eth_call"));
});

test("public API scanner builds an all-chain coverage matrix and preserves key-missing status", () => {
  const catalog = [
    { id: "global", venue: "data", auth: "none", chainIds: [], ops: ["health"], description: "global" },
    { id: "base-only", venue: "dex", auth: "apiKey", chainIds: [8453], ops: ["health"], description: "base" },
  ];
  const health = {
    when: "2026-07-23T00:00:00.000Z",
    providers: {
      global: { ok: true, detail: { ok: true } },
      "base-only": { ok: true, detail: { ok: false, configured: false } },
    },
  };
  const report = buildPublicApiCoverage(catalog, health);
  assert.equal(report.coveredChainCount, 11);
  assert.ok(report.chains[8453].providers.includes("global"));
  assert.ok(report.chains[8453].providers.includes("base-only"));
  assert.equal(report.providers["base-only"].status, "key-missing");
});
