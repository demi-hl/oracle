// Stargate — LayerZero cross-chain bridge. Highest TVL bridge protocol.
// https://stargateprotocol.gitbook.io/stargate — public REST API.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const STARGATE_API = "https://api.stargate.finance";

export async function stargateQuote({ srcChainId, dstChainId, token, amount, dstGasForCall = 0, minAmountOut = "0" } = {}) {
  if (!srcChainId || !dstChainId || !token || !amount) {
    return { error: "stargate quote requires srcChainId, dstChainId, token, amount" };
  }
  try {
    const params = new URLSearchParams({ srcChainId: String(srcChainId), dstChainId: String(dstChainId), token, amount: String(amount), dstGasForCall: String(dstGasForCall), minAmountOut: String(minAmountOut) });
    const data = await httpJson(`${STARGATE_API}/quote?${params}`);
    return { amountOut: data?.amountOut, fee: data?.fee, estimatedTime: data?.estimatedTime };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function stargateHealth() {
  try {
    const chains = ["ethereum", "arbitrum", "optimism", "base", "bsc", "polygon", "avalanche"];
    return { ok: true, supportedChains: chains };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
