// Yearn Finance — yield aggregator across strategies.
// https://docs.yearn.fi — public API.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

const YEARN_API = "https://api.yearn.fi/v1";

export async function yearnVaults() {
  try {
    const data = await httpJson(`${YEARN_API}/vaults/all`);
    return (data || []).map(v => ({
      name: v?.name,
      symbol: v?.symbol,
      apy: v?.apy?.net_apy ? `${(Number(v.apy.net_apy) * 100).toFixed(2)}%` : null,
      tvl: v?.tvl?.tvl_deposited,
      chain: v?.chainId,
      type: v?.type || "v2",
    }));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function yearnHealth() {
  try {
    return { ok: true, note: "Yearn — yield aggregator across Ethereum, Arbitrum, Optimism, Fantom" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
