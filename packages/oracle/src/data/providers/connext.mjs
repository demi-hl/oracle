// Connext — canonical cross-chain bridge (xcall).
// https://docs.connext.network — public REST API.
// Never signs, never broadcasts.

import { httpJson } from "../http.mjs";

export const CONNEXT_API = "https://api.connext.network";

export async function connextQuote({ originDomain, destinationDomain, originToken, destinationToken, amount } = {}) {
  if (!originDomain || !destinationDomain || !originToken || !destinationToken || !amount) {
    return { error: "connext quote requires originDomain, destinationDomain, originToken, destinationToken, amount" };
  }
  try {
    const body = { originDomain: String(originDomain), destinationDomain: String(destinationDomain), originToken, destinationToken, amount: String(amount) };
    const data = await httpJson(`${CONNEXT_API}/estimate`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { amountOut: data?.amountOut, fee: data?.fee, estimatedTime: data?.estimatedTransferTime };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

export async function connextHealth() {
  try {
    return { ok: true, note: "Connext Amarok — canonical bridge across 20+ chains" };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
