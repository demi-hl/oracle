// Squid Router — Axelar-powered cross-chain bridge + swap.
// https://docs.squidrouter.com — public REST API, no key.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const SQUID_API = "https://api.squidrouter.com/v1";

export async function squidQuote({ fromChain, toChain, fromToken, toToken, fromAmount, fromAddress, slippage = 1.0 } = {}) {
  if (!fromChain || !toChain || !fromToken || !toToken || !fromAmount || !fromAddress) {
    return { error: "squid quote requires fromChain, toChain, fromToken, toToken, fromAmount, fromAddress" };
  }
  try {
    const body = { fromChain, toChain, fromToken, toToken, fromAmount: String(fromAmount), fromAddress, slippage };
    const data = await httpJson(`${SQUID_API}/route`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { route: data?.route ?? {}, toAmount: data?.route?.estimate?.toAmount, fee: data?.route?.estimate?.feeCosts };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function squidHealth() {
  try {
    const tokens = await httpJson(`${SQUID_API}/tokens`);
    return { ok: true, tokenCount: tokens?.tokens?.length ?? 0 };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
