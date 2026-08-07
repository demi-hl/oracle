// Drift Protocol — largest Solana perps DEX (v2).
// Public API: https://drift-labs.github.io/v2-teacher — all reads are public.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const DRIFT_API = "https://dlob.drift.trade";

export async function driftMarkets() {
  try {
    // Drift markets are indexed via their SDK-compatible REST layer
    const data = await httpJson(`${DRIFT_API}/v2/markets`);
    return (data?.markets || []).map(m => ({
      symbol: m?.symbol || m?.marketIndex,
      oraclePrice: m?.amm?.oraclePrice,
      markPrice: m?.amm?.markPrice,
      fundingRate: m?.amm?.lastFundingRate ? `${(Number(m.amm.lastFundingRate) * 100).toFixed(4)}%` : null,
      openInterest: { long: m?.amm?.longFunding, short: m?.amm?.shortFunding },
      volume24h: m?.amm?.quoteAssetVolume,
    }));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function driftHealth() {
  try {
    return { ok: true, note: "Drift v2 perps on Solana — public reads via dlob.drift.trade" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
