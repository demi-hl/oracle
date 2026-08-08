import { hlCandleSnapshot, hlFundingHistory } from "../data/providers/hl-info.mjs";

const INTERVAL_MS = Object.freeze({
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
});

function finite(value, path) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${path} must be finite`);
  return parsed;
}

function integer(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function freeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) freeze(entry);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freeze(entry);
  }
  return Object.freeze(value);
}

export function intervalToMs(interval) {
  const ms = INTERVAL_MS[interval];
  if (!ms) throw new TypeError(`unsupported strategy interval: ${interval}`);
  return ms;
}

export function normalizeHyperliquidCandles(rows, { endTime = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Array.isArray(rows)) throw new TypeError("Hyperliquid candles must be an array");
  integer(endTime, "endTime");
  const byTime = new Map();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError(`candles[${index}] must be an object`);
    }
    const t = integer(Number(row.t), `candles[${index}].t`);
    const closeTime = integer(Number(row.T), `candles[${index}].T`);
    if (closeTime > endTime) continue;
    const bar = {
      t,
      o: finite(row.o, `candles[${index}].o`),
      h: finite(row.h, `candles[${index}].h`),
      l: finite(row.l, `candles[${index}].l`),
      c: finite(row.c, `candles[${index}].c`),
      v: finite(row.v, `candles[${index}].v`),
    };
    if (bar.h < Math.max(bar.o, bar.c, bar.l)) {
      throw new TypeError(`candles[${index}].h is below another price`);
    }
    if (bar.l > Math.min(bar.o, bar.c, bar.h)) {
      throw new TypeError(`candles[${index}].l is above another price`);
    }
    if (bar.v < 0) throw new TypeError(`candles[${index}].v must be non-negative`);
    const previous = byTime.get(t);
    if (previous && JSON.stringify(previous) !== JSON.stringify(bar)) {
      throw new TypeError(`conflicting duplicate candle at timestamp ${t}`);
    }
    if (!previous) byTime.set(t, bar);
  }
  return freeze([...byTime.values()].sort((a, b) => a.t - b.t));
}

function normalizeFunding(rows, endTime) {
  if (!Array.isArray(rows)) throw new TypeError("Hyperliquid funding history must be an array");
  const byTime = new Map();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError(`funding[${index}] must be an object`);
    }
    const time = integer(Number(row.time), `funding[${index}].time`);
    if (time > endTime) continue;
    byTime.set(time, {
      time,
      fundingRate: finite(row.fundingRate, `funding[${index}].fundingRate`),
    });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function fetchFundingRange({ coin, startTime, endTime }, opts) {
  const rows = [];
  let cursor = Math.max(0, startTime - 8 * 3_600_000);
  let complete = false;
  for (let page = 0; page < 16 && cursor <= endTime; page++) {
    const batch = await hlFundingHistory({ coin, startTime: cursor, endTime }, opts);
    if (!Array.isArray(batch)) throw new TypeError("Hyperliquid funding history must be an array");
    rows.push(...batch);
    let latest = cursor;
    for (const row of batch) {
      const time = Number(row?.time);
      if (Number.isSafeInteger(time) && time > latest) latest = time;
    }
    if (batch.length < 500 || latest >= endTime) {
      complete = true;
      break;
    }
    if (latest <= cursor) throw new Error("Hyperliquid funding history pagination did not advance");
    cursor = latest + 1;
  }
  if (!complete) {
    throw new Error("strategy history exceeds the bounded funding history limit");
  }
  return normalizeFunding(rows, endTime);
}

function attachFunding(bars, funding, intervalMs) {
  let cursor = 0;
  let latestRate = null;
  return bars.map((bar) => {
    const end = bar.t + intervalMs;
    let paymentRate = 0;
    while (cursor < funding.length && funding[cursor].time < end) {
      const event = funding[cursor];
      latestRate = event.fundingRate;
      if (event.time >= bar.t) paymentRate += event.fundingRate;
      cursor += 1;
    }
    return latestRate == null
      ? { ...bar, fundingPaymentRate: paymentRate }
      : { ...bar, fundingRate: latestRate, fundingPaymentRate: paymentRate };
  });
}

export async function fetchHyperliquidStrategyBars(input, opts = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("strategy history input must be an object");
  }
  const coin = String(input.coin || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,11}$/.test(coin)) {
    throw new TypeError("coin must be an uppercase Hyperliquid asset id");
  }
  const interval = String(input.interval || "15m");
  const intervalMs = intervalToMs(interval);
  if (input.endTime == null) throw new TypeError("endTime is required for deterministic history");
  const endTime = integer(input.endTime, "endTime");
  const count = input.count == null ? 1500 : input.count;
  if (!Number.isInteger(count) || count < 20 || count > 5000) {
    throw new TypeError("count must be an integer from 20 to 5000");
  }
  const startTime = input.startTime == null
    ? Math.max(0, endTime - count * intervalMs)
    : integer(input.startTime, "startTime");
  if (startTime >= endTime) throw new TypeError("startTime must be before endTime");
  const [rows, funding] = await Promise.all([
    hlCandleSnapshot({ coin, interval, startTime, endTime }, opts),
    fetchFundingRange({ coin, startTime, endTime }, opts),
  ]);
  const candles = normalizeHyperliquidCandles(rows, { endTime });
  const bars = freeze(attachFunding(candles, funding, intervalMs));
  return freeze({
    coin,
    interval,
    range: { startTime, endTime },
    bars,
  });
}
