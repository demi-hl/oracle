// Ondo Finance — tokenized real-world assets (USDY, OUSG treasuries).
// https://ondo.finance — public pool data.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const ONDO_API = "https://api.ondo.finance/v1";

export async function ondoPools() {
  try {
    const data = await httpJson(`${ONDO_API}/pools`);
    return (data?.pools || data || []).map(p => ({
      name: p?.name,
      symbol: p?.symbol,
      apy: p?.apy ? `${(Number(p.apy) * 100).toFixed(2)}%` : null,
      tvl: p?.tvl,
      chain: p?.chain,
      type: "RWA", // real-world asset
    }));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function ondoHealth() {
  try {
    return { ok: true, note: "Ondo Finance — tokenized US treasuries + bonds" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
