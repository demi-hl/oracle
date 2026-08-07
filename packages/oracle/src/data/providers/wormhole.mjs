// Wormhole — Portal bridge + cross-chain messaging.
// https://docs.wormhole.com — public REST APIs.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const WORMHOLE_API = "https://api.portalbridge.com/v1";

export async function wormholeQuote({ fromChain, toChain, token, amount } = {}) {
  if (!fromChain || !toChain || !token || !amount) {
    return { error: "wormhole quote requires fromChain, toChain, token, amount" };
  }
  try {
    const params = new URLSearchParams({ fromChain: String(fromChain), toChain: String(toChain), token, amount: String(amount) });
    const data = await httpJson(`${WORMHOLE_API}/quote?${params}`);
    return { amountOut: data?.amountOut, fee: data?.fee, estimatedTime: data?.estimatedTime };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function wormholeHealth() {
  try {
    return { ok: true, note: "Portal bridge by Wormhole — 30+ chains" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
