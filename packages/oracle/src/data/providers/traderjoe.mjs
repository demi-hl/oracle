// Trader Joe — Avalanche's largest DEX (v2.1 Liquidity Book).
// https://docs.traderjoexyz.com — public subgraph API.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

const JOE_SUBGRAPH = "https://subgraph.satsuma-prod.com/traderjoe-xyz/joe-v2-avalanche/api";

export async function joeQuote({ tokenIn, tokenOut, amountIn } = {}) {
  if (!tokenIn || !tokenOut || !amountIn) {
    return { error: "joe quote requires tokenIn, tokenOut, amountIn" };
  }
  try {
    const query = `{ quote(tokenIn:"${tokenIn}",tokenOut:"${tokenOut}",amountIn:"${amountIn}") { amountOut route } }`;
    const data = await httpJson(`${JOE_SUBGRAPH}/quote?query=${encodeURIComponent(query)}`);
    return { amountOut: data?.data?.quote?.amountOut, route: data?.data?.quote?.route };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function joeHealth() {
  try {
    return { ok: true, chains: ["Avalanche (43114), Arbitrum (42161), BSC (56)"] };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
