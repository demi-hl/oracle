// Aerodrome Slipstream prepare adapter tests (Base) — mocked eth_call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import {
  AERODROME_CHAINS,
  aerodromeQuoteExactIn,
  aerodromePrepareExactIn,
  aerodromeHealth,
  aerodromeChains,
} from "../src/data/providers/aerodrome.mjs";
import { dataCatalog, dataCall } from "../src/data/desk-data.mjs";
import { assertPreparedProtocolRoute, EXECUTABLE_PROTOCOL_PROVIDERS } from "../src/protocol-execution.mjs";
import { venuesFor } from "../src/venues.mjs";

// Protocol-route validation requires authenticated auto-slippage guards.
process.env.ORACLE_ROUTE_ATTESTATION_SECRET = ["oracle", "test", "aerodrome", "attestation"].join("-");

const USER = "0x1111111111111111111111111111111111111111";
const WETH = AERODROME_CHAINS[8453].weth;
const USDC = AERODROME_CHAINS[8453].usdc;
const ROUTER = AERODROME_CHAINS[8453].router;
const QUOTER = AERODROME_CHAINS[8453].quoter;

const QUOTER_IFACE = new Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

function mockQuoteResult(amountOut = 1_900_000n) {
  return QUOTER_IFACE.encodeFunctionResult("quoteExactInputSingle", [
    amountOut,
    0n,
    1,
    120000n,
  ]);
}

function fetchAlways(resultHex) {
  return async () => ({
    ok: true,
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: resultHex }),
  });
}

/** Sequential results for tick-spacing probe order [1,50,100,200,2000]. */
function fetchByCallOrder(resultsByIndex) {
  let call = 0;
  return async () => {
    const idx = call++;
    const result = resultsByIndex[idx];
    if (!result) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: `no pool idx=${idx}` } }),
      };
    }
    return {
      ok: true,
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
    };
  };
}

test("catalog includes aerodrome prepare on Base only", () => {
  const p = dataCatalog().find((x) => x.id === "aerodrome");
  assert.ok(p);
  assert.deepEqual(p.chainIds, [8453]);
  assert.equal(p.execution, "prepare");
  assert.equal(p.auth, "none");
  assert.ok(p.ops.includes("quote") && p.ops.includes("prepare"));
  assert.ok(EXECUTABLE_PROTOCOL_PROVIDERS.includes("aerodrome"));
});

test("aerodrome chains lists Base router/quoter", async () => {
  const chains = await aerodromeChains();
  assert.equal(chains.length, 1);
  assert.equal(chains[0].chainId, 8453);
  assert.equal(chains[0].router.toLowerCase(), ROUTER.toLowerCase());
  assert.equal(chains[0].quoter.toLowerCase(), QUOTER.toLowerCase());
});

test("Base venues allowlist includes Aerodrome Slipstream router/quoter/factory", () => {
  const v = venuesFor(8453);
  assert.ok(v.has(ROUTER.toLowerCase()));
  assert.ok(v.has(QUOTER.toLowerCase()));
  assert.ok(v.has(AERODROME_CHAINS[8453].factory.toLowerCase()));
});

test("aerodrome quote picks best tick spacing and attaches auto-slippage", async () => {
  // Order of tries: 1, 50, 100, 200, 2000
  const fetchImpl = fetchByCallOrder({
    0: null, // ts=1 fail
    1: mockQuoteResult(1_800_000n), // 50
    2: mockQuoteResult(2_000_000n), // 100 best
    3: mockQuoteResult(1_700_000n), // 200
    4: mockQuoteResult(1_600_000n), // 2000
  });
  const quote = await aerodromeQuoteExactIn(
    {
      chainId: 8453,
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountIn: "1000000000000000",
    },
    { fetchImpl, rpcUrl: "http://mock.local" }
  );
  assert.equal(quote.venue, "aerodrome");
  assert.equal(quote.chainId, 8453);
  assert.equal(quote.tickSpacing, 100);
  assert.equal(quote.amountOut, "2000000");
  assert.equal(quote.autoSlippage.mode, "auto");
  assert.ok(Number(quote.autoSlippage.selectedBps) <= 100);
  assert.equal(quote.amountOutMinimum, quote.autoSlippage.minAmountOut);
  assert.equal(quote.autoSlippage.venue.toLowerCase(), ROUTER.toLowerCase());
  assert.equal(quote.tokenIn.toLowerCase(), WETH.toLowerCase());
});

test("aerodrome prepare builds native ETH router calldata with tickSpacing + deadline", async () => {
  const route = await aerodromePrepareExactIn(
    {
      chainId: 8453,
      tokenIn: "ETH",
      tokenOut: "USDC",
      amountIn: "1000000000000000",
      tickSpacing: 100,
      recipient: USER,
      deadlineSeconds: 120,
    },
    { fetchImpl: fetchAlways(mockQuoteResult(1_900_000n)), rpcUrl: "http://mock.local", nowSeconds: 1_800_000_000 }
  );
  assert.equal(route.provider, "aerodrome");
  // Calldata is assembled, but nothing is signed — a prepare is not authority.
  assert.equal(route.calldataReady, true);
  assert.equal(route.requiresUserSignature, true);
  assert.equal(route.signingReady, false);
  assert.equal(route.broadcastReady, false);
  assert.equal(route.transaction.to.toLowerCase(), ROUTER.toLowerCase());
  assert.equal(route.transaction.from.toLowerCase(), USER.toLowerCase());
  assert.equal(String(route.transaction.value), "1000000000000000");
  assert.equal(route.requiresApproval, null);
  assert.equal(route.deadline, 1_800_000_120);
  assert.ok(String(route.transaction.data).startsWith("0xa026383e"));
  const txs = assertPreparedProtocolRoute(route, {
    provider: "aerodrome",
    chainId: 8453,
    from: USER,
  });
  assert.equal(txs.length, 1);
  assert.equal(txs[0].to.toLowerCase(), ROUTER.toLowerCase());
  assert.throws(
    () => assertPreparedProtocolRoute(
      { ...route, transaction: { ...route.transaction, data: `${route.transaction.data}00` } },
      { provider: "aerodrome", chainId: 8453, from: USER },
    ),
    /not bound to this call/,
  );
});

test("aerodrome ERC-20 input requires approval to Slipstream router", async () => {
  const route = await aerodromePrepareExactIn(
    {
      chainId: 8453,
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: "1000000",
      tickSpacing: 100,
      recipient: USER,
    },
    { fetchImpl: fetchAlways(mockQuoteResult(500000000000000n)), rpcUrl: "http://mock.local" }
  );
  assert.ok(route.requiresApproval);
  assert.equal(route.requiresApproval.token.toLowerCase(), USDC.toLowerCase());
  assert.equal(route.requiresApproval.spender.toLowerCase(), ROUTER.toLowerCase());
  assert.equal(String(route.transaction.value), "0");
});

test("aerodrome rejects unsupported chain", async () => {
  await assert.rejects(
    () =>
      aerodromeQuoteExactIn(
        { chainId: 1, amountIn: "1" },
        { fetchImpl: fetchAlways(mockQuoteResult()), rpcUrl: "http://mock.local" }
      ),
    /unsupported chainId/
  );
});

test("dataCall aerodrome.quote via facade", async () => {
  const quote = await dataCall(
    "aerodrome",
    "quote",
    {
      chainId: 8453,
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: "1000000000000000",
      tickSpacing: 100,
    },
    { fetchImpl: fetchAlways(mockQuoteResult(123456n)), rpcUrl: "http://mock.local" }
  );
  assert.equal(quote.venue, "aerodrome");
  assert.equal(quote.amountOut, "123456");
});

test("aerodrome health with mocked rpc is ok", async () => {
  const h = await aerodromeHealth({
    chainId: 8453,
    fetchImpl: fetchAlways(mockQuoteResult(1_884_000n)),
    rpcUrl: "http://mock.local",
  });
  assert.equal(h.ok, true);
  assert.equal(h.chainId, 8453);
  assert.ok(h.amountOutUsdc > 0);
});
