// Aevo — on-chain options exchange (calls/puts on ETH, BTC, SOL).
// https://api-docs.aevo.xyz — public REST API.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const AEVO_API = "https://api.aevo.xyz";

export async function aevoMarkets() {
  try {
    const data = await httpJson(`${AEVO_API}/markets`);
    return (data || []).map(m => ({
      instrument: m?.instrument_name,
      type: m?.instrument_type, // option, perpetual
      markPrice: m?.mark_price,
      indexPrice: m?.index_price,
      fundingRate: m?.funding_rate ? `${(Number(m.funding_rate) * 100).toFixed(4)}%` : null,
      openInterest: m?.open_interest,
      volume24h: m?.volume_24h,
    }));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function aevoHealth() {
  try {
    const data = await httpJson(`${AEVO_API}/ping`);
    return { ok: data?.status === "ok" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
