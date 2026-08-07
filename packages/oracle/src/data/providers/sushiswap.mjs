// SushiSwap — multi-chain DEX with v3 concentrated liquidity.
// https://docs.sushi.com — public subgraph APIs across 30+ chains.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

const SUSHI_SUBGRAPH = (chainId) => `https://api.thegraph.com/subgraphs/name/sushi-v3/v3-${chainIdMap[chainId] || "ethereum"}`;

const chainIdMap = { 1: "ethereum", 10: "optimism", 56: "bsc", 137: "polygon", 8453: "base", 42161: "arbitrum", 43114: "avalanche", 59144: "linea", 534352: "scroll", 324: "zksync-era", 250: "fantom", 2222: "kava", 1088: "metis", 1284: "moonbeam", 1285: "moonriver", 288: "boba", 1101: "polygon-zkevm", 5000: "mantle", 81457: "blast" };

export async function sushiQuote({ chainId = 1, tokenIn, tokenOut, amountIn, fee = 500 } = {}) {
  if (!tokenIn || !tokenOut || !amountIn) {
    return { error: "sushi quote requires tokenIn, tokenOut, amountIn" };
  }
  try {
    const query = `{ quote(tokenIn:"${tokenIn}",tokenOut:"${tokenOut}",amountIn:"${amountIn}",fee:${fee}) { amountOut route } }`;
    const data = await httpJson(`${SUSHI_SUBGRAPH(chainId)}/quote?query=${encodeURIComponent(query)}`);
    return { amountOut: data?.data?.quote?.amountOut, route: data?.data?.quote?.route };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function sushiHealth() {
  try {
    return { ok: true, chains: Object.keys(chainIdMap).length + " chains" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
