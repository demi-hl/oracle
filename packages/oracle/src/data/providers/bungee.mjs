// Bungee/Socket — bridge aggregator with different inventory than LI.FI.
// https://docs.bungee.exchange — public REST API.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const BUNGEE_API = "https://api.socket.tech/v2";

export async function bungeeQuote({ fromChainId, toChainId, fromToken, toToken, fromAmount, userAddress } = {}) {
  if (!fromChainId || !toChainId || !fromToken || !toToken || !fromAmount || !userAddress) {
    return { error: "bungee quote requires fromChainId, toChainId, fromToken, toToken, fromAmount, userAddress" };
  }
  try {
    const params = new URLSearchParams({ fromChainId: String(fromChainId), toChainId: String(toChainId), fromTokenAddress: fromToken, toTokenAddress: toToken, fromAmount: String(fromAmount), userAddress, sort: "output", singleTxOnly: "false" });
    const data = await httpJson(`${BUNGEE_API}/quote?${params}`);
    return { amountOut: data?.result?.toAmount, feeUsd: data?.result?.totalGasFeesInUsd, route: data?.result?.route, estimatedTime: data?.result?.serviceTime ? `${data.result.serviceTime}s` : "unknown" };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function bungeeHealth() {
  try {
    const data = await httpJson(`${BUNGEE_API}/supported/chains`);
    return { ok: true, chainCount: data?.result?.length ?? 0 };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
