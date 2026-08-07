// PancakeSwap — largest BSC DEX, v3 concentrated liquidity on multiple chains.
// https://developers.pancakeswap.finance — public REST + subgraph APIs.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

const PANCAKE_SUBGRAPH = "https://api.thegraph.com/subgraphs/name/pancakeswap/exchange-v3-bsc";

export async function pancakeQuote({ chainId = 56, tokenIn, tokenOut, amountIn, fee = 500 } = {}) {
  if (!tokenIn || !tokenOut || !amountIn) {
    return { error: "pancake quote requires tokenIn, tokenOut, amountIn" };
  }
  try {
    const body = { tokenIn: String(tokenIn).toLowerCase(), tokenOut: String(tokenOut).toLowerCase(), amountIn: String(amountIn), fee: String(fee) };
    const data = await httpJson(`${PANCAKE_SUBGRAPH}/quote`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { amountOut: data?.amountOut, route: data?.route };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function pancakeHealth() {
  try {
    return { ok: true, chains: ["bsc (56)", "ethereum (1)", "arbitrum (42161)", "base (8453)", "opbnb (204)", "zksync (324)", "linea (59144)"] };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
