import test from "node:test";
import assert from "node:assert/strict";
import {
  formatUnits,
  portfolioBalance,
  resolvePortfolioAddresses,
} from "../src/data/providers/portfolio.mjs";
import { dataCall } from "../src/data/desk-data.mjs";

const EVM = "0x000000000000000000000000000000000000dEaD";
const SOLANA = "11111111111111111111111111111111";
const BITCOIN = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(url, init = {}) {
  const href = String(url);
  const parsedUrl = new URL(href);
  const host = parsedUrl.hostname;
  let body = {};
  try {
    body = init.body ? JSON.parse(init.body) : {};
  } catch {
    body = {};
  }

  if (host === "coins.llama.fi" && parsedUrl.pathname.startsWith("/prices/current/")) {
    return Promise.resolve(response({
      coins: {
        "coingecko:ethereum": { price: 2000, timestamp: 123, confidence: 0.99 },
        "coingecko:polygon-ecosystem-token": { price: 0.2, timestamp: 123, confidence: 0.9 },
        "coingecko:binancecoin": { price: 600, timestamp: 123, confidence: 0.99 },
        "coingecko:avalanche-2": { price: 20, timestamp: 123, confidence: 0.99 },
        "coingecko:hyperliquid": { price: 20, timestamp: 123, confidence: 0.99 },
        "coingecko:tether": { price: 1, timestamp: 123, confidence: 0.99 },
        "coingecko:solana": { price: 100, timestamp: 123, confidence: 0.99 },
        "coingecko:bitcoin": { price: 50000, timestamp: 123, confidence: 0.99 },
      },
    }));
  }

  if (host === "ethereum.publicnode.com" || host === "base-rpc.publicnode.com") {
    assert.equal(body.method, "eth_getBalance");
    const wei = host === "base-rpc.publicnode.com" ? 2n * 10n ** 18n : 10n ** 18n;
    return Promise.resolve(response({ jsonrpc: "2.0", id: 1, result: `0x${wei.toString(16)}` }));
  }

  if (host === "api.mainnet-beta.solana.com") {
    if (body.method === "getBalance") {
      return Promise.resolve(response({
        jsonrpc: "2.0",
        id: 1,
        result: { context: { slot: 99 }, value: 2_000_000_000 },
      }));
    }
    if (body.method === "getTokenAccountsByOwner") {
      const program = body.params?.[1]?.programId;
      const standard = program?.startsWith("Tokenkeg");
      const value = standard
        ? [
            {
              pubkey: "acct-standard",
              account: {
                data: {
                  parsed: {
                    info: {
                      mint: "So11111111111111111111111111111111111111112",
                      owner: SOLANA,
                      tokenAmount: { amount: "1500000", decimals: 6, uiAmount: 1.5, uiAmountString: "1.5" },
                    },
                  },
                },
              },
            },
            {
              pubkey: "acct-candidate",
              account: {
                data: {
                  parsed: {
                    info: {
                      mint: "NFT11111111111111111111111111111111111111111",
                      owner: SOLANA,
                      tokenAmount: { amount: "1", decimals: 0, uiAmount: 1, uiAmountString: "1" },
                    },
                  },
                },
              },
            },
          ]
        : [];
      return Promise.resolve(response({ jsonrpc: "2.0", id: 1, result: { context: { slot: 99 }, value } }));
    }
  }

  if (host === "mempool.space" && parsedUrl.pathname.startsWith("/api/address/")) {
    return Promise.resolve(response({
      chain_stats: { funded_txo_sum: 100_000_000, spent_txo_sum: 0 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
    }));
  }

  if (host === "api.hyperliquid.xyz" && parsedUrl.pathname === "/info") {
    if (body.type === "spotClearinghouseState") {
      return Promise.resolve(response({ balances: [
        { coin: "HYPE", total: "2", hold: "0" },
        { coin: "USDC", total: "3", hold: "0" },
      ] }));
    }
    if (body.type === "clearinghouseState") {
      return Promise.resolve(response({
        marginSummary: { accountValue: "10" },
        withdrawable: "8",
        assetPositions: [{ position: { coin: "BTC", szi: "0.1", entryPx: "40000", positionValue: "5000", unrealizedPnl: "100" } }],
      }));
    }
    if (body.type === "allMids") {
      return Promise.resolve(response({ HYPE: "20", BTC: "50000" }));
    }
  }

  throw new Error(`unexpected mock request: ${href} ${JSON.stringify(body)}`);
}

const args = {
  addresses: {
    evm: EVM,
    solana: SOLANA,
    bitcoin: BITCOIN,
    hyperliquid: EVM,
  },
  evmChainIds: [1, 8453],
};

const opts = { fetchImpl: mockFetch, env: {}, timeoutMs: 1000 };

test("portfolio address resolution uses public family defaults only", () => {
  assert.deepEqual(
    resolvePortfolioAddresses({}, {
      ORACLE_EVM_ADDRESS: EVM,
      ORACLE_SOLANA_ADDRESS: SOLANA,
      ORACLE_BITCOIN_ADDRESS: BITCOIN,
    }),
    { evm: EVM, solana: SOLANA, bitcoin: BITCOIN, hyperliquid: EVM },
  );
  assert.equal(formatUnits("123456789", 8), "1.23456789");
});

test("portfolioBalance aggregates live-shaped family reads and labels incomplete coverage", async () => {
  const result = await portfolioBalance(args, opts);
  assert.equal(result.readOnly, true);
  assert.equal(result.coverage.requestedSurfaces, 5);
  assert.equal(result.coverage.evmChainsOk, 2);
  assert.equal(result.valuation.knownUsd, 2000 + 4000 + 200 + 50000 + 40 + 3 + 10);
  assert.equal(result.valuation.complete, false);
  assert.match(result.valuation.label, /not a complete portfolio total/);

  const ethereum = result.chains.find((chain) => chain.chainId === 1);
  const base = result.chains.find((chain) => chain.chainId === 8453);
  const solana = result.chains.find((chain) => chain.family === "solana");
  const bitcoin = result.chains.find((chain) => chain.family === "bitcoin");
  const hyperliquid = result.chains.find((chain) => chain.family === "hyperliquid");

  assert.equal(ethereum.native.amount, "1");
  assert.equal(base.native.amount, "2");
  assert.equal(ethereum.fungibleTokens.status, "unavailable");
  assert.equal(solana.native.amount, "2");
  assert.equal(solana.fungibleTokens.assets.length, 1);
  assert.equal(solana.collectibles.assets[0].classification, "collectible-candidate");
  assert.equal(bitcoin.native.amount, "1");
  assert.equal(bitcoin.collectibles.status, "unavailable");
  assert.equal(bitcoin.collectibles.unknownNotEmpty, true);
  assert.equal(hyperliquid.spot.balances.find((item) => item.coin === "HYPE").usdValue, 40);
  assert.equal(hyperliquid.perps.accountValueUsd, "10");
  assert.deepEqual(result.unsupportedFamilies.map((item) => item.family), ["cosmos", "sui", "aptos"]);
});

test("portfolio balances route through the public data facade", async () => {
  const result = await dataCall("portfolio", "balances", args, opts);
  assert.equal(result.provider, "portfolio");
  assert.equal(result.operation, "balances");
  assert.equal(result.coverage.evmChainsOk, 2);
});

test("a caller-supplied env selects the RPC endpoint, not just the address", async () => {
  // Address resolution has always honoured `opts.env`. RPC URL resolution reads
  // it too, so if the scan does not thread it down, a caller that passes its own
  // env gets its addresses respected and its endpoints silently ignored — every
  // read lands on a public fallback instead of the configured node.
  const seen = [];
  const recordingFetch = (url, init) => {
    seen.push(String(url));
    return mockFetch(url, init);
  };

  await portfolioBalance(
    { addresses: { evm: EVM }, evmChainIds: [1] },
    {
      fetchImpl: recordingFetch,
      // ETH_RPC_URL is chain 1's first rpcEnv entry in the chain registry.
      env: { ETH_RPC_URL: "https://sentinel-eth.invalid/rpc" },
      timeoutMs: 1000,
    },
  );

  assert.ok(
    seen.some((url) => url.startsWith("https://sentinel-eth.invalid/")),
    "the caller's configured RPC endpoint must actually be used",
  );
  assert.ok(
    !seen.some((url) => url.includes("ethereum.publicnode.com")),
    "a configured endpoint must not be bypassed for the public fallback",
  );
});

