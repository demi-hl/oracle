// THORChain — native cross-chain swaps. No wrapped tokens.
// Midgard public API: https://midgard.ninerealms.com/v2/doc
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const THORCHAIN_API = "https://midgard.ninerealms.com/v2";

export async function thorchainQuote({ fromAsset, toAsset, amount, destination } = {}) {
  if (!fromAsset || !toAsset || !amount) {
    return { error: "thorchain quote requires fromAsset, toAsset, amount" };
  }
  try {
    const params = new URLSearchParams({ from_asset: fromAsset, to_asset: toAsset, amount: String(amount), destination: destination || "" });
    const data = await httpJson(`${THORCHAIN_API}/quote/swap?${params}`);
    return {
      expectedAmountOut: data?.expected_amount_out,
      fees: data?.fees,
      slippageBps: data?.slippage_bps,
      inboundAddress: data?.inbound_address,
      memo: data?.memo,
      estimatedTime: data?.total_swap_seconds ? `${Math.round(data.total_swap_seconds / 60)} min` : "unknown",
    };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function thorchainHealth() {
  try {
    const data = await httpJson(`${THORCHAIN_API}/health`);
    return { ok: data?.scannerHeight > 0 };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
