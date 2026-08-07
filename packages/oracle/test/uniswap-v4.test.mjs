// Uniswap V4 quoter unit tests (hermetic)

import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, Interface, ZeroAddress } from "ethers";
import {
  UNI_V4_CHAINS,
  uniV4Chains,
  uniV4QuoteExactIn,
  uniV4PrepareExactIn,
  computeV4PoolId,
} from "../src/data/providers/uniswap-v4.mjs";
import { dataCatalog, dataCall } from "../src/data/desk-data.mjs";

const IFACE = new Interface([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

function mockQuoteResult(amountOut = 1_930_000n) {
  return IFACE.encodeFunctionResult("quoteExactInputSingle", [amountOut, 120000n]);
}

test("catalog includes every configured uniswap-v4 chain", () => {
  const p = dataCatalog().find((x) => x.id === "uniswap-v4");
  assert.ok(p);
  assert.deepEqual(
    [...p.chainIds].sort((a, b) => a - b),
    Object.keys(UNI_V4_CHAINS).map(Number).sort((a, b) => a - b),
  );
  assert.equal(p.auth, "none");
  assert.ok(p.ops.includes("quote"));
  assert.ok(p.chainIds.includes(4663), "RH must be on V4 catalog");
  assert.ok(p.chainIds.includes(1));
  assert.ok(p.chainIds.includes(8453));
  assert.ok(p.chainIds.includes(42161));
});

test("uniV4Chains lists every configured network", async () => {
  const c = await uniV4Chains();
  assert.equal(c.length, Object.keys(UNI_V4_CHAINS).length);
  assert.ok(c.every((x) => x.quoter && x.poolManager && x.weth && x.usdc));
});

test("poolId derivation is stable and matches the verified mainnet ETH/USDC pool", () => {
  // Verified on MAD singleton-venue-identity 2026-08-02.
  const poolId = computeV4PoolId({
    currency0: ZeroAddress,
    currency1: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    fee: 500,
    tickSpacing: 10,
    hooks: ZeroAddress,
  });
  assert.equal(
    poolId,
    "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27",
  );
});

test("RH SQUEEZE poolId matches the pinned Doppler pool", () => {
  // From rhbot squeeze-v4 worktree SQUEEZE_V4.
  const poolId = computeV4PoolId({
    currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    currency1: "0xF444F3C77C77a33F7c8d8fcab8a1E88aFb843dA5",
    fee: 25_000,
    tickSpacing: 8,
    hooks: "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544",
  });
  assert.equal(
    poolId,
    "0x3b054359e248009e797afbcfa975fa4cf5147d503421af53f179be1abf63d46f",
  );
});

test("quoteExactIn picks best fee tier (mocked rpc)", async () => {
  const outs = {
    "100/1": null,
    "500/10": mockQuoteResult(2_000_000n),
    "3000/60": mockQuoteResult(1_900_000n),
    "10000/200": mockQuoteResult(1_800_000n),
    "25000/8": null,
  };
  let call = 0;
  const tierOrder = [
    [100, 1],
    [500, 10],
    [3000, 60],
    [10000, 200],
    [25000, 8],
  ];
  const fetchImpl = async () => {
    const [fee, tick] = tierOrder[call++] ?? [25000, 8];
    const result = outs[`${fee}/${tick}`];
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

  const q = await uniV4QuoteExactIn(
    {
      chainId: 8453,
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountIn: "1000000000000000",
    },
    { fetchImpl, rpcUrl: "http://mock.local" },
  );
  assert.equal(q.fee, 500);
  assert.equal(q.tickSpacing, 10);
  assert.equal(q.amountOut, "2000000");
  assert.equal(q.chainId, 8453);
  assert.equal(q.venue, "uniswap-v4");
  assert.equal(q.executionReady, false);
  assert.equal(q.autoSlippage.mode, "auto");
  assert.ok(q.poolId);
});

test("dataCall uniswap-v4.quote via facade", async () => {
  const result = IFACE.encodeFunctionResult("quoteExactInputSingle", [123456n, 1n]);
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
  });
  const q = await dataCall(
    "uniswap-v4",
    "quote",
    {
      chainId: 1,
      tokenIn: "WETH",
      tokenOut: "USDC",
      amountIn: "1000",
      fee: 500,
      tickSpacing: 10,
    },
    { fetchImpl, rpcUrl: "http://mock.local" },
  );
  assert.equal(q.amountOut, "123456");
  assert.equal(q.fee, 500);
  assert.equal(q.venue, "uniswap-v4");
});

test("unsupported chain throws", async () => {
  await assert.rejects(
    () =>
      uniV4QuoteExactIn({
        chainId: 324,
        amountIn: "1",
        tokenIn: "WETH",
        tokenOut: "USDC",
        fee: 500,
        tickSpacing: 10,
      }),
    /unsupported chainId/,
  );
});

test("RH 4663 is configured with PoolManager + Quoter", () => {
  const rh = UNI_V4_CHAINS[4663];
  assert.ok(rh);
  assert.equal(rh.poolManager.toLowerCase(), "0x8366a39cc670b4001a1121b8f6a443a643e40951");
  assert.equal(rh.quoter.toLowerCase(), "0x8dc178efb8111bb0973dd9d722ebeff267c98f94");
  assert.equal(rh.universalRouter.toLowerCase(), "0x8876789976decbfcbbbe364623c63652db8c0904");
});

test("prepare encodes a cross-chain V4 Universal Router plan but never signs or broadcasts", async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: mockQuoteResult(2_000_000n) }),
  });
  const recipient = "0x1111111111111111111111111111111111111111";
  const p = await uniV4PrepareExactIn({
    chainId: 42161,
    tokenIn: UNI_V4_CHAINS[42161].weth,
    tokenOut: UNI_V4_CHAINS[42161].usdc,
    amountIn: "1000000000000000",
    fee: 500,
    tickSpacing: 10,
    hooks: ZeroAddress,
    recipient,
    slippageBps: 50,
  }, { fetchImpl, rpcUrl: "http://mock.local", nowSeconds: 1_700_000_000 });

  assert.equal(p.prepareReady, true);
  assert.equal(p.calldataReady, true);
  assert.equal(p.executionReady, false);
  assert.equal(p.signingReady, false);
  assert.equal(p.broadcastReady, false);
  assert.equal(p.transaction.to.toLowerCase(), UNI_V4_CHAINS[42161].universalRouter.toLowerCase());
  assert.equal(p.transaction.from, recipient);
  assert.equal(p.transaction.value, "0");
  assert.equal(p.quote.amountOutMinimum, "1990000");
  assert.equal(p.quote.poolId, computeV4PoolId({ ...p.quote.triedTiers[0].poolKey }));
  assert.equal(p.deadline, 1_700_000_300);

  const decoded = new Interface([
    "function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
  ]).decodeFunctionData("execute", p.transaction.data);
  assert.equal(decoded.commands, "0x10");
  assert.equal(decoded.inputs.length, 1);
  assert.equal(decoded.deadline, 1_700_000_300n);
  const coder = AbiCoder.defaultAbiCoder();
  const [actions, params] = coder.decode(["bytes", "bytes[]"], decoded.inputs[0]);
  assert.equal(actions, "0x060c0f");
  assert.equal(params.length, 3);
  const [swap] = coder.decode([
    "tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)",
  ], params[0]);
  assert.equal(swap.poolKey.fee, 500n);
  assert.equal(swap.poolKey.tickSpacing, 10n);
  assert.equal(swap.amountIn, 1_000_000_000_000_000n);
  assert.equal(swap.amountOutMinimum, 1_990_000n);
  assert.equal(swap.minHopPriceX36, 0n);
  assert.equal(swap.hookData, "0x");
});

test("prepare refuses implicit recipient/slippage and performs no RPC call", async () => {
  let calls = 0;
  const opts = { fetchImpl: async () => { calls += 1; throw new Error("must not call"); }, rpcUrl: "http://mock.local" };
  await assert.rejects(() => uniV4PrepareExactIn({
    chainId: 8453, tokenIn: UNI_V4_CHAINS[8453].weth, tokenOut: UNI_V4_CHAINS[8453].usdc, amountIn: "1", slippageBps: 50,
  }, opts), /recipient/);
  await assert.rejects(() => uniV4PrepareExactIn({
    chainId: 8453, tokenIn: UNI_V4_CHAINS[8453].weth, tokenOut: UNI_V4_CHAINS[8453].usdc, amountIn: "1", recipient: "0x1111111111111111111111111111111111111111",
  }, opts), /slippageBps/);
  assert.equal(calls, 0);
});
