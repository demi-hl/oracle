import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";

import { CHAIN_CONFIGS } from "../src/scanner/chains.config.mjs";
import { defineEvmScanner } from "../src/scanner/evm-scanner.mjs";
import {
  __clearScanners,
  createScanner,
  registerScanner,
  scannerCoverage,
  SCANNER_CAPABILITIES,
} from "../src/scanner/contract.mjs";
import {
  UNI_V3_CHAINS,
  uniV3PrepareExactIn,
} from "../src/data/providers/uniswap-v3.mjs";

const QUOTER_IFACE = new Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const ROUTER_IFACE = new Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
]);

const TOKEN = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

function quoteFetch(amountOut = 2_000_000n) {
  const result = QUOTER_IFACE.encodeFunctionResult("quoteExactInputSingle", [
    amountOut,
    0n,
    1,
    120000n,
  ]);
  return async () => ({
    ok: true,
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
  });
}

test("Robinhood scanner exposes all ten capabilities and shares provider addresses", () => {
  const config = CHAIN_CONFIGS.find((chain) => chain.chainId === 4663);
  const scanner = createScanner(defineEvmScanner(config));
  const coverage = scanner.capabilities();

  assert.deepEqual(coverage.supported, [...SCANNER_CAPABILITIES]);
  assert.deepEqual(coverage.unsupported, []);
  assert.equal(config.wrappedNative.toLowerCase(), UNI_V3_CHAINS[4663].weth.toLowerCase());
  assert.equal(
    config.venues.find((venue) => venue.kind === "quoter").address.toLowerCase(),
    UNI_V3_CHAINS[4663].quoter.toLowerCase(),
  );
  assert.equal(
    config.venues.find((venue) => venue.kind === "router").address.toLowerCase(),
    UNI_V3_CHAINS[4663].router.toLowerCase(),
  );

  __clearScanners();
  registerScanner(defineEvmScanner(config));
  assert.deepEqual(scannerCoverage().chains[4663].supported, [...SCANNER_CAPABILITIES]);
  assert.equal(scannerCoverage().chains[4663].failClosed, false);
  __clearScanners();
});

test("Robinhood scanner rejects malformed quote and prepare addresses", async () => {
  const config = CHAIN_CONFIGS.find((chain) => chain.chainId === 4663);
  const scanner = createScanner(defineEvmScanner(config));

  await assert.rejects(
    () => scanner.quote({ tokenIn: "WETH", tokenOut: TOKEN, amountIn: "1" }),
    /valid 20-byte addresses/,
  );
  await assert.rejects(
    () => scanner.prepareUnsignedTx({ tokenIn: TOKEN, tokenOut: config.wrappedNative, amountIn: "1", recipient: "bad" }),
    /valid recipient address/,
  );
});

test("Robinhood direct preparation binds recipient and slippage without signing", async () => {
  const prepared = await uniV3PrepareExactIn(
    {
      chainId: 4663,
      tokenIn: "WETH",
      tokenOut: TOKEN,
      amountIn: "1000000000000000000",
      recipient: RECIPIENT,
      slippageBps: 50,
      fee: 500,
    },
    { fetchImpl: quoteFetch(), rpcUrl: "http://mock.local", nowSeconds: 1_700_000_000 },
  );

  const [, calls] = ROUTER_IFACE.decodeFunctionData("multicall", prepared.transaction.data);
  const [params] = ROUTER_IFACE.decodeFunctionData("exactInputSingle", calls[0]);
  assert.equal(params.recipient, RECIPIENT);
  assert.equal(prepared.autoSlippage.capBps, 50);
  assert.equal(prepared.autoSlippage.selectedBps, 30);
  assert.equal(params.amountOutMinimum, 1_994_000n);
  assert.equal(params.amountOutMinimum.toString(), prepared.quote.amountOutMinimum);
  assert.equal(prepared.transaction.to.toLowerCase(), UNI_V3_CHAINS[4663].router.toLowerCase());
  assert.equal(prepared.requiresUserSignature, true);
  assert.equal(prepared.signingReady, false);
  assert.equal(prepared.broadcastReady, false);
  assert.equal("signature" in prepared, false);
  assert.equal("signedTransaction" in prepared, false);
  assert.equal("transactionHash" in prepared, false);
});

test("Robinhood direct preparation rejects malformed token and recipient addresses", async () => {
  const opts = { fetchImpl: quoteFetch(), rpcUrl: "http://mock.local" };
  await assert.rejects(
    () => uniV3PrepareExactIn({ chainId: 4663, tokenIn: "bad", tokenOut: TOKEN, amountIn: "1", recipient: RECIPIENT }, opts),
    /invalid token address/,
  );
  await assert.rejects(
    () => uniV3PrepareExactIn({ chainId: 4663, tokenIn: "WETH", tokenOut: TOKEN, amountIn: "1", recipient: "bad" }, opts),
    /invalid address/i,
  );
});
