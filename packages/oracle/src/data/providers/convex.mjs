// Convex Finance — Curve liquidity booster + yield optimizer.
// https://docs.convexfinance.com — public API.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

const CONVEX_API = "https://api.convexfinance.com/api";

export async function convexPools() {
  try {
    const data = await httpJson(`${CONVEX_API}/pools`);
    return (data || []).map(p => ({
      name: p?.curvePool?.name || p?.name,
      curveApy: p?.curvePool?.apy ? `${(Number(p.curvePool.apy) * 100).toFixed(2)}%` : null,
      convexApy: p?.apy ? `${(Number(p.apy) * 100).toFixed(2)}%` : null,
      tvl: p?.tvl,
      boosted: p?.boosted || false,
    }));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function convexHealth() {
  try {
    return { ok: true, note: "Convex — CRV/CVX yield optimizer on Ethereum" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
