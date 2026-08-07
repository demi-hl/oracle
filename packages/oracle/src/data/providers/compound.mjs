// Compound — OG lending protocol ($2B+ TVL across chains).
// https://docs.compound.finance — public API.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

const COMPOUND_API = "https://api.compound.finance/api/v2";

export async function compoundMarkets() {
  try {
    const data = await httpJson(`${COMPOUND_API}/ctoken`);
    return (data?.cToken || []).map(m => ({
      symbol: m?.symbol,
      underlying: m?.underlying_symbol,
      supplyApy: m?.supply_rate?.value ? `${(Number(m.supply_rate.value) * 100).toFixed(2)}%` : null,
      borrowApy: m?.borrow_rate?.value ? `${(Number(m.borrow_rate.value) * 100).toFixed(2)}%` : null,
      totalSupply: m?.total_supply?.value,
      totalBorrow: m?.total_borrows?.value,
      collateralFactor: m?.collateral_factor?.value ? `${(Number(m.collateral_factor.value) * 100).toFixed(0)}%` : null,
    }));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function compoundHealth() {
  try {
    return { ok: true, note: "Compound v2 — Ethereum mainnet lending" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
