// ChangeNOW swap provider.
//
// ChangeNOW is a centralized, non-custodial instant swap service that does
// not require account registration for basic swaps. Different risk model
// from DEX routes: funds are sent to a ChangeNOW deposit address and the
// swapped asset is returned to the user's withdrawal address.
//
// Public API: https://api.changenow.io/v2
// Docs: https://documenter.getpostman.com/view/8180765/SVfTPBxP
//
// This module is read/prepare only. It quotes routes and provides deposit
// instructions. The user sends funds themselves; Oracle never holds or moves
// funds. No API key required for public endpoints.
//
// Never signs, never broadcasts, never holds keys.

import { httpJson } from "../http.mjs";

export const CHANGENOW_API = "https://api.changenow.io/v2";

const KNOWN_CURRENCIES_CACHE = new Map();
let CURRENCIES_LAST_FETCH = 0;
const CURRENCY_TTL_MS = 600_000; // 10 minutes

/**
 * List available currencies from ChangeNOW.
 * Cached for 10 minutes to avoid rate-limiting on repeated queries.
 */
export async function changenowCurrencies({ active = true } = {}) {
  const now = Date.now();
  if (KNOWN_CURRENCIES_CACHE.size && now - CURRENCIES_LAST_FETCH < CURRENCY_TTL_MS) {
    return [...KNOWN_CURRENCIES_CACHE.values()];
  }

  try {
    const data = await httpJson(`${CHANGENOW_API}/exchange/currencies?active=${active ? "true" : "false"}`);
    KNOWN_CURRENCIES_CACHE.clear();
    for (const c of data ?? []) {
      KNOWN_CURRENCIES_CACHE.set(String(c.ticker).toLowerCase(), c);
    }
    CURRENCIES_LAST_FETCH = now;
    return data ?? [];
  } catch (e) {
    if (KNOWN_CURRENCIES_CACHE.size) return [...KNOWN_CURRENCIES_CACHE.values()];
    return { error: String(e.message || e).slice(0, 200) };
  }
}

/**
 * Get the minimum exchangeable amount for a pair.
 */
export async function changenowMinAmount(fromTicker, toTicker) {
  if (!fromTicker || !toTicker) return { error: "changenow minAmount requires fromTicker and toTicker" };
  try {
    const data = await httpJson(
      `${CHANGENOW_API}/exchange/min-amount/${encodeURIComponent(fromTicker)}_${encodeURIComponent(toTicker)}`,
    );
    return { minAmount: data?.minAmount ?? "0" };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

/**
 * Get an estimated exchange amount for a pair.
 */
export async function changenowEstimate(fromTicker, toTicker, fromAmount, { flow = "standard" } = {}) {
  if (!fromTicker || !toTicker || !fromAmount) {
    return { error: "changenow estimate requires fromTicker, toTicker, fromAmount" };
  }
  try {
    const params = new URLSearchParams({
      fromCurrency: String(fromTicker).toLowerCase(),
      toCurrency: String(toTicker).toLowerCase(),
      fromAmount: String(fromAmount),
      flow,
    });
    const data = await httpJson(`${CHANGENOW_API}/exchange/estimated-amount?${params}`);
    return {
      fromAmount: data?.fromAmount,
      toAmount: data?.toAmount,
      rate: data?.rate,
      flow: data?.flow ?? flow,
    };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

/**
 * Full quote: use estimate if fromAmount is provided, otherwise minAmount.
 */
export async function changenowQuote({ fromTicker, toTicker, fromAmount, flow } = {}) {
  if (!fromTicker || !toTicker) {
    return { error: "changenow quote requires fromTicker and toTicker" };
  }

  const min = await changenowMinAmount(fromTicker, toTicker);
  if (min.error) return min;

  const amount = fromAmount ?? min.minAmount;
  const est = await changenowEstimate(fromTicker, toTicker, amount, { flow });
  if (est.error) return est;

  const currencies = await changenowCurrencies();
  const fromInfo = currencies.find(c => String(c?.ticker).toLowerCase() === String(fromTicker).toLowerCase());
  const toInfo = currencies.find(c => String(c?.ticker).toLowerCase() === String(toTicker).toLowerCase());

  return {
    provider: "changenow",
    fromTicker,
    toTicker,
    fromAmount: amount,
    toAmount: est.toAmount,
    estimatedRate: est.rate,
    minAmount: min.minAmount,
    flow: est.flow,
    networkFee: fromInfo?.networkFee ?? null,
    kycRequired: fromInfo?.kycRequired ?? toInfo?.kycRequired ?? false,
    riskDisclosure: "ChangeNOW is a centralized swap service. Funds are sent to a ChangeNOW deposit address. Not self-custodial during the swap window.",
  };
}

/**
 * ChangeNOW health check.
 */
export async function changenowHealth() {
  try {
    const c = await changenowCurrencies();
    if (c?.error) return { ok: false, error: c.error };
    return { ok: true, currencyCount: Array.isArray(c) ? c.length : 0 };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
