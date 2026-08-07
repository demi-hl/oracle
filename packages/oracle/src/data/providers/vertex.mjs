// Vertex Protocol — Arbitrum perps + spot DEX with unified cross-margin.
// Public API: https://vertex-protocol.gitbook.io — all reads are public.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const VERTEX_API = "https://gateway.prod.vertexprotocol.com/v2";

export async function vertexMarkets() {
  try {
    const data = await httpJson(`${VERTEX_API}/query`, { method: "POST", body: JSON.stringify({ all_markets: {} }), headers: { "content-type": "application/json" } });
    return (data?.data?.all_markets || []).map(m => ({
      market: m?.market,
      type: m?.type, // spot or perp
      oraclePrice: m?.oracle_price_x18 ? (Number(BigInt(m.oracle_price_x18)) / 1e18).toFixed(4) : null,
      minSize: m?.min_size,
      productId: m?.product_id,
    }));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function vertexOrderbook(productId) {
  try {
    const data = await httpJson(`${VERTEX_API}/query`, { method: "POST", body: JSON.stringify({ market_liquidity: { product_id: Number(productId), depth: 5 } }), headers: { "content-type": "application/json" } });
    const liq = data?.data?.market_liquidity;
    return { bids: liq?.bids || [], asks: liq?.asks || [] };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function vertexHealth() {
  try {
    const data = await httpJson(`${VERTEX_API}/status`);
    return { ok: true, status: data?.status || "unknown" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
