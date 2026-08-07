// Orca — Solana's #2 DEX (concentrated liquidity AMM).
// https://docs.orca.so — public API via Jupiter for quotes.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

const JUPITER_QUOTE = "https://quote-api.jup.ag/v6";

export async function orcaQuote({ inputMint, outputMint, amount, slippageBps = 50 } = {}) {
  if (!inputMint || !outputMint || !amount) {
    return { error: "orca quote requires inputMint, outputMint, amount" };
  }
  try {
    const params = new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: String(slippageBps), onlyDirectRoutes: "true" });
    const data = await httpJson(`${JUPITER_QUOTE}/quote?${params}`);
    const orcaRoutes = (data?.routePlan || []).filter(r => r?.swapInfo?.label?.toLowerCase().includes("orca"));
    return { amountOut: data?.outAmount, priceImpactPct: data?.priceImpactPct, orcaRoutes: orcaRoutes.length };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function orcaHealth() {
  try {
    return { ok: true, note: "Orca — Solana concentrated liquidity AMM" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
