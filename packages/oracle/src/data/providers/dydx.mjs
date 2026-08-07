// dYdX — standalone perps chain (Cosmos SDK). Largest decentralized perps venue.
// Public REST API: https://dydx.exchange — all reads are public.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const DYDX_API = "https://api.dydx.exchange";

export async function dydxMarkets(limit = 50) {
  try {
    const data = await httpJson(`${DYDX_API}/v4/perpetualMarkets?limit=${limit}`);
    return (data?.markets || []).map(m => ({
      ticker: m?.ticker,
      oraclePrice: m?.oraclePrice,
      indexPrice: m?.indexPrice,
      nextFundingRate: m?.nextFundingRate ? `${(Number(m.nextFundingRate) * 100).toFixed(4)}%` : null,
      openInterest: m?.openInterest,
      volume24h: m?.volume24H,
    }));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function dydxOrderbook(ticker) {
  try {
    const data = await httpJson(`${DYDX_API}/v4/orderbooks/perpetualMarket/${ticker}`);
    return { bids: data?.bids?.slice(0, 5), asks: data?.asks?.slice(0, 5) };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function dydxHealth() {
  try {
    const data = await httpJson(`${DYDX_API}/v4/time`);
    return { ok: true, serverTime: data?.iso };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
