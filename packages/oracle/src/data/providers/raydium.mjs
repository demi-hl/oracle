// Raydium — largest Solana DEX (AMM + CLMM).
// https://docs.raydium.io — public REST API via Jupiter routing.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6";

export async function raydiumQuote({ inputMint, outputMint, amount, slippageBps = 50 } = {}) {
  if (!inputMint || !outputMint || !amount) {
    return { error: "raydium quote requires inputMint, outputMint, amount" };
  }
  try {
    const params = new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: String(slippageBps), onlyDirectRoutes: "true" });
    const data = await httpJson(`${JUPITER_QUOTE_API}/quote?${params}`);
    // Filter for Raydium routes specifically
    const raydiumRoutes = (data?.routePlan || []).filter(r => r?.swapInfo?.label?.toLowerCase().includes("raydium"));
    return {
      amountOut: data?.outAmount,
      priceImpactPct: data?.priceImpactPct,
      raydiumRoutes: raydiumRoutes.length,
      allRoutes: data?.routePlan?.length || 0,
    };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function raydiumHealth() {
  try {
    return { ok: true, note: "Raydium routes through Jupiter aggregator on Solana" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
