// Pure indicator math. Same length as input; null until sufficient history. No I/O.

function assertValues(values) {
  if (!Array.isArray(values)) throw new TypeError("values must be an array");
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new TypeError(`values[${i}] must be a finite number`);
    }
  }
}

function assertPeriod(period) {
  if (!Number.isInteger(period) || period <= 0) {
    throw new TypeError("period must be a positive integer");
  }
}

function assertBars(bars) {
  if (!Array.isArray(bars)) throw new TypeError("bars must be an array");
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b == null || typeof b !== "object") throw new TypeError(`bars[${i}] must be an object`);
    for (const k of ["o", "h", "l", "c"]) {
      const v = b[k];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new TypeError(`bars[${i}].${k} must be a finite number`);
      }
    }
    if (b.h < b.l) throw new TypeError(`bars[${i}] high must be >= low`);
  }
}

/** Simple moving average. */
export function sma(values, period) {
  assertValues(values);
  assertPeriod(period);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with SMA of the first period. */
export function ema(values, period) {
  assertValues(values);
  assertPeriod(period);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = k * values[i] + (1 - k) * prev;
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder RSI. First RSI at index `period` (needs `period` deltas).
 * Zero-loss => 100; zero-gain => 0; both zero => 50 (finite, deterministic).
 */
export function rsi(values, period) {
  assertValues(values);
  assertPeriod(period);
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain, avgLoss) {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD: line = ema(fast) - ema(slow), signal = EMA of line (seeded over first
 * signalPeriod non-null line values), histogram = line - signal.
 */
export function macd(values, opts = {}) {
  assertValues(values);
  const fastPeriod = opts.fastPeriod;
  const slowPeriod = opts.slowPeriod;
  const signalPeriod = opts.signalPeriod;
  assertPeriod(fastPeriod);
  assertPeriod(slowPeriod);
  assertPeriod(signalPeriod);
  if (fastPeriod >= slowPeriod) throw new TypeError("fastPeriod must be < slowPeriod");

  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const line = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (fast[i] != null && slow[i] != null) line[i] = fast[i] - slow[i];
  }

  const signal = new Array(values.length).fill(null);
  const histogram = new Array(values.length).fill(null);

  // Collect indices where line is available; seed signal with SMA of first signalPeriod line values.
  const lineIdx = [];
  for (let i = 0; i < line.length; i++) if (line[i] != null) lineIdx.push(i);
  if (lineIdx.length >= signalPeriod) {
    let sum = 0;
    for (let j = 0; j < signalPeriod; j++) sum += line[lineIdx[j]];
    let prev = sum / signalPeriod;
    const seedIndex = lineIdx[signalPeriod - 1];
    signal[seedIndex] = prev;
    histogram[seedIndex] = line[seedIndex] - prev;
    const k = 2 / (signalPeriod + 1);
    for (let j = signalPeriod; j < lineIdx.length; j++) {
      const idx = lineIdx[j];
      prev = k * line[idx] + (1 - k) * prev;
      signal[idx] = prev;
      histogram[idx] = line[idx] - prev;
    }
  }

  return { line, signal, histogram };
}

/** Bollinger bands with population standard deviation. */
export function bollinger(values, opts = {}) {
  assertValues(values);
  const period = opts.period;
  const stdDev = opts.stdDev;
  assertPeriod(period);
  if (typeof stdDev !== "number" || !Number.isFinite(stdDev) || stdDev <= 0) {
    throw new TypeError("stdDev must be a finite number > 0");
  }
  const middle = new Array(values.length).fill(null);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  if (values.length < period) return { upper, middle, lower };

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v;
    sumSq += v * v;
    if (i >= period) {
      const old = values[i - period];
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= period - 1) {
      const mean = sum / period;
      // Population variance: E[x^2] - (E[x])^2
      let variance = sumSq / period - mean * mean;
      if (variance < 0 && variance > -1e-12) variance = 0;
      const std = Math.sqrt(variance);
      middle[i] = mean;
      upper[i] = mean + stdDev * std;
      lower[i] = mean - stdDev * std;
    }
  }
  return { upper, middle, lower };
}

/**
 * ATR from true range. Seed is SMA of first `period` TRs (first TR uses h-l only).
 * Subsequent values use Wilder smoothing.
 */
export function atr(bars, period) {
  assertBars(bars);
  assertPeriod(period);
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;

  const tr = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) {
      tr[i] = b.h - b.l;
    } else {
      const prevClose = bars[i - 1].c;
      tr[i] = Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));
    }
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}
