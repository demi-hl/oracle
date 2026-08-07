// Uniswap V3 quoter unit tests (mocked eth_call)

import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import {
  uniV3QuoteExactIn,
  uniV3Chains,
  UNI_V3_CHAINS,
} from "../src/data/providers/uniswap-v3.mjs";
import { dataCatalog, dataCall } from "../src/data/desk-data.mjs";

const IFACE = new Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

function mockQuoteResult(amountOut = 1_930_000n) {
  return IFACE.encodeFunctionResult("quoteExactInputSingle", [
    amountOut,
    0n,
    1,
    120000n,
  ]);
}

test("catalog includes every configured uniswap-v3 chain", () => {
  const p = dataCatalog().find((x) => x.id === "uniswap-v3");
  assert.ok(p);
  assert.deepEqual([...p.chainIds].sort((a, b) => a - b), Object.keys(UNI_V3_CHAINS).map(Number).sort((a, b) => a - b));
  assert.equal(p.auth, "none");
  assert.ok(p.ops.includes("quote"));
  assert.ok(p.ops.includes("ethUsdc"));
});

test("uniV3Chains lists every configured network", async () => {
  const c = await uniV3Chains();
  assert.equal(c.length, Object.keys(UNI_V3_CHAINS).length);
  // Chains with a canonical deployment must expose quoter; venue-only chains
  // (HyperEVM 999) deliberately carry no quoter and are refused unless a venue
  // is named. All chains still carry token addresses.
  assert.ok(c.every((x) => x.weth && x.usdc));
  const canonical = c.filter((x) => UNI_V3_CHAINS[x.chainId].quoter);
  assert.ok(canonical.length > 0);
  assert.ok(canonical.every((x) => x.quoter));
});

test("quoteExactIn picks best fee tier (mocked rpc)", async () => {
  const outs = {
    100: null, // fail empty
    500: mockQuoteResult(2_000_000n),
    3000: mockQuoteResult(1_900_000n),
    10000: mockQuoteResult(1_800_000n),
  };
  // eth_call body is in fetch - intercept via custom fetch that decodes fee from data
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const data = body.params[0].data;
    // fee is packed in the calldata after tokens; easier: cycle by call order
    return {
      ok: true,
      text: async () => {
        // decode fee from ABI-encoded tuple: fee is 4th word of params after selector
        // selector 4 bytes + 5 words offset... simpler: count calls
        return JSON.stringify({ jsonrpc: "2.0", id: 1, result: null });
      },
    };
  };

  // Simpler: always return 500-tier best via sequential results keyed by fee in encode
  let call = 0;
  const feeOrder = [100, 500, 3000, 10000];
  const fetchImpl2 = async (_url, init) => {
    const fee = feeOrder[call++] ?? 10000;
    const result = outs[fee];
    if (!result) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { message: `no pool fee=${fee}` },
          }),
      };
    }
    return {
      ok: true,
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
    };
  };

  const q = await uniV3QuoteExactIn(
    {
      chainId: 8453,
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountIn: "1000000000000000",
    },
    { fetchImpl: fetchImpl2, rpcUrl: "http://mock.local" }
  );
  assert.equal(q.fee, 500);
  assert.equal(q.amountOut, "2000000");
  assert.equal(q.chainId, 8453);
  assert.equal(q.autoSlippage.mode, "auto");
  assert.equal(q.autoSlippage.selectedBps, 30);
  assert.equal(q.amountOutMinimum, q.autoSlippage.minAmountOut);
  assert.equal(q.autoSlippage.venue.toLowerCase(), UNI_V3_CHAINS[8453].router.toLowerCase());
  assert.equal(q.tokenIn.toLowerCase(), UNI_V3_CHAINS[8453].weth.toLowerCase());
});

test("dataCall uniswap-v3.quote via facade", async () => {
  const result = IFACE.encodeFunctionResult("quoteExactInputSingle", [
    123456n,
    0n,
    0,
    1n,
  ]);
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
  });
  const q = await dataCall(
    "uniswap-v3",
    "quote",
    {
      chainId: 1,
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountIn: "1000",
      fee: 3000,
    },
    { fetchImpl, rpcUrl: "http://mock.local" }
  );
  assert.equal(q.amountOut, "123456");
  assert.equal(q.fee, 3000);
  assert.equal(q.autoSlippage.mode, "auto");
  assert.ok(q.autoSlippage.selectedBps <= 100);
});

test("unsupported chain throws", async () => {
  await assert.rejects(
    () =>
      uniV3QuoteExactIn({
        chainId: 999,
        amountIn: "1",
        tokenIn: "WETH",
        tokenOut: "USDC",
        fee: 3000,
      }),
    /no canonical Uniswap v3 deployment/
  );
});
