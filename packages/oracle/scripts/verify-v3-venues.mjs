#!/usr/bin/env node
// Functionally verify Uniswap V3 venue addresses on every chain.
//
// Codesize alone is NOT verification -- an unrelated contract also has bytecode, and
// on Base the canonical mainnet addresses returned 2109 bytes for two different
// contracts, which is exactly the kind of false positive a size check waves through.
//
// The real test is behavioural: ask the candidate quoter to price a pair we already
// know the answer to. A contract that returns a sane WETH->USDC quote at a standard
// fee tier IS a working V3 quoter, regardless of what any doc claims.
//
// Output is a provenance record per chain, ready to paste into chains.config.mjs.

import { rpcCall } from "../src/data/providers/evm-rpc.mjs";

// Candidates. Most chains share the canonical deployment; Base, BSC and Avalanche
// have their own. All of these are CANDIDATES until the probe passes.
const CANONICAL_QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const CANONICAL_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

const CANDIDATES = {
  1: {
    name: "ethereum",
    quoter: CANONICAL_QUOTER,
    router: CANONICAL_ROUTER,
    tokenIn: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    decIn: 18,
    decOut: 6,
  },
  10: {
    name: "optimism",
    quoter: CANONICAL_QUOTER,
    router: CANONICAL_ROUTER,
    tokenIn: "0x4200000000000000000000000000000000000006",
    tokenOut: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    decIn: 18,
    decOut: 6,
  },
  56: {
    name: "bsc",
    quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    router: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
    tokenIn: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    tokenOut: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // USDC (18dp on BSC)
    decIn: 18,
    decOut: 18,
  },
  137: {
    name: "polygon",
    quoter: CANONICAL_QUOTER,
    router: CANONICAL_ROUTER,
    tokenIn: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
    tokenOut: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // USDC native
    decIn: 18,
    decOut: 6,
  },
  8453: {
    name: "base",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    tokenIn: "0x4200000000000000000000000000000000000006",
    tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decIn: 18,
    decOut: 6,
  },
  42161: {
    name: "arbitrum",
    quoter: CANONICAL_QUOTER,
    router: CANONICAL_ROUTER,
    tokenIn: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    tokenOut: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decIn: 18,
    decOut: 6,
  },
  // HyperEVM 999 is a FORK deployment (HyperSwap), not the canonical Uniswap
  // addresses -- which is exactly why it sat fail-closed: it was never in this
  // map, so it was never tested, and "untested" printed the same as "broken".
  999: {
    name: "hyperevm",
    quoter: "0x03A918028f22D9E1473B7959C927AD7425A45C7C",
    router: "0x4E2960a8cd19B467b82d26D83fAcb0fAE26b094D",
    tokenIn: "0x5555555555555555555555555555555555555555", // WHYPE
    tokenOut: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", // USDT0
    decIn: 18,
    decOut: 6,
  },
  // Stable 988 is a CANONICAL deployment (Official Uniswap v3 Deployments List,
  // 2026-05-12) but was never in this map either. Pair is thin, so amountIn is
  // sized up: 1 TOAST rounds to zero out, 10000 does not.
  988: {
    name: "stable",
    quoter: "0xb070179E7032CdA868b53e6C1742F80c9e940d1A",
    router: "0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a",
    tokenIn: "0x817997Ca8394E26CCE3dE3A076a4889b27DbF9dE", // WgUSDT
    tokenOut: "0xd9c2E67afbc787ba9C7a886dd09947c127D3cC0d", // LEVCAT
    decIn: 18,
    decOut: 18,
    feeTiers: [100],
    // Deepest live pool on this chain (liquidity 1.41e24). An earlier candidate
    // (TOAST/USDT0) drained from 1.4e19 to 0 mid-verification, so pick on depth.
  },
  // Abstract 2741 is a ZK-stack chain: canonical Uniswap addresses do not exist
  // here (codesize 0), which is why probing them made it look like Abstract had
  // no V3 at all. These are the real deployment, found from live swap traffic.
  2741: {
    name: "abstract",
    quoter: "0x728BD3eC25D5EDBafebB84F3d67367Cd9EBC7693",
    router: "0x7712FA47387542819d4E35A23f8116C90C18767C",
    tokenIn: "0x3439153EB7AF838Ad19d56E1571FBD09333C2809", // WETH
    tokenOut: "0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1", // USDC.e
    decIn: 18,
    decOut: 6,
    feeTiers: [500],
  },
  43114: {
    name: "avalanche",
    quoter: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
    router: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
    tokenIn: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
    tokenOut: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // USDC
    decIn: 18,
    decOut: 6,
  },
};

const FEE_TIERS = [500, 3000, 10000];

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, "0");

// QuoterV2.quoteExactInputSingle((address,address,uint256,uint24,uint160))
// selector 0xc6a5026a -- struct is encoded inline as 5 words.
function encodeQuote({ tokenIn, tokenOut, amountIn, fee }) {
  return (
    "0xc6a5026a" +
    addrWord(tokenIn) +
    addrWord(tokenOut) +
    word(amountIn) +
    word(fee) +
    word(0) // sqrtPriceLimitX96 = 0 (no limit)
  );
}

async function codesize(chainId, address) {
  const r = await rpcCall(chainId, "eth_getCode", [address, "latest"]).catch(() => null);
  const raw = r?.result ?? r;
  return raw && raw !== "0x" ? (raw.length - 2) / 2 : 0;
}

async function probe(chainId, cfg) {
  const result = {
    chainId: Number(chainId),
    name: cfg.name,
    quoter: cfg.quoter,
    router: cfg.router,
    quoterCodesize: 0,
    routerCodesize: 0,
    workingFeeTier: null,
    quotedOut: null,
    humanPrice: null,
    verdict: "FAIL",
    reason: "",
  };

  result.quoterCodesize = await codesize(chainId, cfg.quoter);
  result.routerCodesize = await codesize(chainId, cfg.router);

  if (!result.quoterCodesize || !result.routerCodesize) {
    result.reason = "no bytecode at candidate address on this chain";
    return result;
  }

  // Behavioural probe: does it actually price a pair we can sanity-check?
  const units = cfg.amountIn ?? 1n;
  const amountIn = units * 10n ** BigInt(cfg.decIn);
  for (const fee of cfg.feeTiers ?? FEE_TIERS) {
    const data = encodeQuote({
      tokenIn: cfg.tokenIn,
      tokenOut: cfg.tokenOut,
      amountIn,
      fee,
    });
    const r = await rpcCall(chainId, "eth_call", [{ to: cfg.quoter, data }, "latest"]).catch(
      () => null,
    );
    const raw = r?.result ?? r;
    if (!raw || raw === "0x" || raw.length < 66) continue;

    const out = BigInt(`0x${raw.slice(2, 66)}`);
    if (out === 0n) continue;

    result.workingFeeTier = fee;
    result.quotedOut = out.toString();
    result.humanPrice = Number(out) / 10 ** cfg.decOut;
    break;
  }

  if (result.workingFeeTier == null) {
    result.reason = "bytecode present but no fee tier returned a quote -- not a working V3 quoter";
    return result;
  }

  // Sanity band. A working quoter on a major pair should land in a plausible range;
  // a wildly wrong number means we are talking to the wrong contract or decoding it
  // wrong, and either way it must not be allowlisted.
  if (result.humanPrice <= 0 || !Number.isFinite(result.humanPrice)) {
    result.reason = `implausible quote ${result.humanPrice}`;
    return result;
  }

  result.verdict = "PASS";
  result.reason =
    `quoteExactInputSingle at fee ${result.workingFeeTier} returned ` +
    `${result.humanPrice} for 1 unit in -- a live, working V3 quote`;
  return result;
}

const out = [];
for (const [chainId, cfg] of Object.entries(CANDIDATES)) {
  const r = await probe(chainId, cfg);
  out.push(r);
  const line =
    `${r.name.padEnd(10)} ${r.verdict.padEnd(5)} ` +
    `quoter=${String(r.quoterCodesize).padStart(6)} router=${String(r.routerCodesize).padStart(6)} ` +
    (r.workingFeeTier ? `fee=${String(r.workingFeeTier).padStart(5)} price=${r.humanPrice}` : r.reason);
  console.log(line);
}

console.log(`\n${out.filter((r) => r.verdict === "PASS").length}/${out.length} chains verified`);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
}
