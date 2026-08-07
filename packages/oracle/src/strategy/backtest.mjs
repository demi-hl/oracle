// Deterministic Hyperliquid strategy backtester. No network, keys, clock, I/O, or randomness.

import {
  STRATEGY_COMPILER_HASH,
  STRATEGY_COMPILER_VERSION,
  compileStrategy,
} from "./compiler.mjs";
import { normalizeStrategy } from "./schema.mjs";

const DEFAULTS = Object.freeze({
  initialEquityUsd: 10_000,
  takerFeeBps: 3.5,
  builderFeeBps: 2,
  slippageBps: 2,
  latencyBars: 1,
});

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function deepFreeze(value) {
  if (value == null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value != null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

function assertBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new TypeError("bars must be a non-empty array");
  }
  let prevT = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b == null || typeof b !== "object" || Array.isArray(b)) {
      throw new TypeError(`bars[${i}] must be an object`);
    }
    const { t, o, h, l, c, v } = b;
    if (!isFiniteNumber(t)) throw new TypeError(`bars[${i}].t must be finite`);
    for (const [k, val] of [
      ["o", o],
      ["h", h],
      ["l", l],
      ["c", c],
      ["v", v],
    ]) {
      if (!isFiniteNumber(val)) throw new TypeError(`bars[${i}].${k} must be a finite number`);
    }
    if (h < Math.max(o, c, l)) {
      throw new TypeError(`bars[${i}] high must be >= max(open, close, low)`);
    }
    if (l > Math.min(o, c, h)) {
      throw new TypeError(`bars[${i}] low must be <= min(open, close, high)`);
    }
    if (prevT != null && !(t > prevT)) {
      throw new TypeError("bars t must be strictly increasing");
    }
    prevT = t;
    if ("fundingRate" in b && b.fundingRate != null && !isFiniteNumber(b.fundingRate)) {
      throw new TypeError(`bars[${i}].fundingRate must be finite when present`);
    }
    if ("openInterest" in b && b.openInterest != null && !isFiniteNumber(b.openInterest)) {
      throw new TypeError(`bars[${i}].openInterest must be finite when present`);
    }
  }
}

function parseOptions(options) {
  if (options == null) options = {};
  if (!isPlainObject(options)) throw new TypeError("options must be a plain object");

  const out = { ...DEFAULTS };
  const allowed = new Set([
    "initialEquityUsd",
    "takerFeeBps",
    "builderFeeBps",
    "slippageBps",
    "latencyBars",
    "nowMs",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`unknown option "${key}"`);
  }

  if ("initialEquityUsd" in options) {
    if (!isFiniteNumber(options.initialEquityUsd) || options.initialEquityUsd <= 0) {
      throw new TypeError("initialEquityUsd must be a positive finite number");
    }
    out.initialEquityUsd = options.initialEquityUsd;
  }
  for (const feeKey of ["takerFeeBps", "builderFeeBps", "slippageBps"]) {
    if (feeKey in options) {
      const v = options[feeKey];
      if (!isFiniteNumber(v) || v < 0) {
        throw new TypeError(`${feeKey} must be a finite number >= 0`);
      }
      out[feeKey] = v;
    }
  }
  if ("latencyBars" in options) {
    const v = options.latencyBars;
    if (!Number.isInteger(v) || v < 1) {
      throw new TypeError("latencyBars must be an integer >= 1");
    }
    out.latencyBars = v;
  }
  if ("nowMs" in options) {
    if (!Number.isInteger(options.nowMs)) {
      throw new TypeError("nowMs must be an integer epoch milliseconds");
    }
    out.nowMs = options.nowMs;
  }
  return out;
}

function bpsToFrac(bps) {
  return bps / 10_000;
}

function applyEntrySlippage(price, side, slippageBps) {
  const s = bpsToFrac(slippageBps);
  return side === "long" ? price * (1 + s) : price * (1 - s);
}

function applyExitSlippage(price, side, slippageBps) {
  const s = bpsToFrac(slippageBps);
  return side === "long" ? price * (1 - s) : price * (1 + s);
}

function feeOnNotional(notional, takerFeeBps, builderFeeBps) {
  const taker = Math.abs(notional) * bpsToFrac(takerFeeBps);
  const builder = Math.abs(notional) * bpsToFrac(builderFeeBps);
  return { taker, builder, total: taker + builder };
}

function computeNotional(equity, risk) {
  const raw = equity * (risk.positionSizePct / 100) * risk.maxLeverage;
  return Math.min(raw, risk.maxNotionalUsd);
}

function stopPrice(entry, side, stopLossPct) {
  const f = stopLossPct / 100;
  return side === "long" ? entry * (1 - f) : entry * (1 + f);
}

function takePrice(entry, side, takeProfitPct) {
  const f = takeProfitPct / 100;
  return side === "long" ? entry * (1 + f) : entry * (1 - f);
}

function liqPrice(entry, side, leverage) {
  if (!(leverage > 0)) return side === "long" ? 0 : Number.POSITIVE_INFINITY;
  return side === "long" ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage);
}

function touchesStop(bar, side, stop) {
  return side === "long" ? bar.l <= stop : bar.h >= stop;
}

function touchesTake(bar, side, take) {
  return side === "long" ? bar.h >= take : bar.l <= take;
}

function touchesLiq(bar, side, liq) {
  return side === "long" ? bar.l <= liq : bar.h >= liq;
}

function sharpeFromCurve(equityCurve) {
  if (equityCurve.length < 3) return 0;
  const rets = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    const cur = equityCurve[i].equity;
    if (!(prev > 0)) continue;
    rets.push((cur - prev) / prev);
  }
  if (rets.length < 2) return 0;
  let sum = 0;
  for (const r of rets) sum += r;
  const mean = sum / rets.length;
  let varSum = 0;
  for (const r of rets) varSum += (r - mean) ** 2;
  const std = Math.sqrt(varSum / (rets.length - 1));
  if (!(std > 0)) return 0;
  return mean / std;
}

function maxDrawdownPct(equityCurve) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const pt of equityCurve) {
    const eq = pt.equity;
    if (eq > peak) peak = eq;
    if (peak > 0) {
      const dd = ((peak - eq) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/**
 * Run a deterministic closed-bar backtest.
 * Decisions use closed bar t only; fills at next open (+ latency) with adverse slip.
 */
export function backtestStrategy(strategyInput, bars, options = {}) {
  const opts = parseOptions(options);
  assertBars(bars);

  if (opts.nowMs !== undefined) {
    normalizeStrategy(strategyInput, { nowMs: opts.nowMs });
  }

  const compiled = compileStrategy(strategyInput);
  if (opts.nowMs !== undefined && compiled.strategy.risk.expiresAt <= opts.nowMs) {
    throw new Error("strategy is expired: risk.expiresAt must be strictly greater than nowMs");
  }

  const risk = compiled.strategy.risk;
  const evaluated = compiled.evaluateAll(bars);
  const latency = opts.latencyBars;
  const slipBps = opts.slippageBps;
  const takerBps = opts.takerFeeBps;
  const builderBps = opts.builderFeeBps;

  let equity = opts.initialEquityUsd;
  let feesUsd = 0;
  let builderFeesUsd = 0;
  let fundingUsd = 0;
  let slippageUsd = 0;
  let turnoverUsd = 0;

  const trades = [];
  const liquidations = [];
  const flags = [];
  const equityCurve = [];

  let position = null;
  let cooldownUntil = 0;
  const pending = [];

  function schedule(item) {
    pending.push(item);
  }

  function openPosition(i, side, rawOpen) {
    const notional = computeNotional(equity, risk);
    if (!(notional > 0) || !(rawOpen > 0)) return;
    const fill = applyEntrySlippage(rawOpen, side, slipBps);
    const qty = notional / fill;
    const slipCost = Math.abs(fill - rawOpen) * qty;
    const fees = feeOnNotional(notional, takerBps, builderBps);

    equity -= fees.total;
    feesUsd += fees.taker;
    builderFeesUsd += fees.builder;
    slippageUsd += slipCost;
    turnoverUsd += notional;

    position = {
      side,
      entryBarIndex: i,
      entryPrice: fill,
      qty,
      notionalUsd: notional,
      stop: stopPrice(fill, side, risk.stopLossPct),
      take: takePrice(fill, side, risk.takeProfitPct),
      liq: liqPrice(fill, side, risk.maxLeverage),
      entryFees: fees.taker,
      entryBuilderFees: fees.builder,
      entrySlippageUsd: slipCost,
      fundingAccrued: 0,
    };
  }

  function closePosition(i, rawPrice, reason, applySlip) {
    if (!position) return;
    const side = position.side;
    let reference = rawPrice;
    if (reason === "liquidation") reference = position.liq;
    else if (reason === "stop_loss") reference = position.stop;
    else if (reason === "take_profit") reference = position.take;

    let fillPrice = reference;
    if (reason === "liquidation") {
      fillPrice = position.liq;
    } else if (applySlip) {
      fillPrice = applyExitSlippage(reference, side, slipBps);
    }

    const qty = position.qty;
    const exitNotional = qty * fillPrice;
    const fees = feeOnNotional(exitNotional, takerBps, builderBps);
    const slipCost =
      reason === "liquidation" ? 0 : Math.abs(fillPrice - reference) * qty;

    let grossPnl;
    if (side === "long") {
      grossPnl = (fillPrice - position.entryPrice) * qty;
    } else {
      grossPnl = (position.entryPrice - fillPrice) * qty;
    }

    equity += grossPnl;
    equity -= fees.total;
    feesUsd += fees.taker;
    builderFeesUsd += fees.builder;
    slippageUsd += slipCost;
    turnoverUsd += exitNotional;

    const trade = {
      side,
      entryBarIndex: position.entryBarIndex,
      entryTime: bars[position.entryBarIndex].t,
      entryPrice: position.entryPrice,
      exitBarIndex: i,
      exitTime: bars[i].t,
      exitPrice: fillPrice,
      exitReason: reason,
      qty,
      notionalUsd: position.notionalUsd,
      grossPnlUsd: grossPnl,
      feesUsd: position.entryFees + fees.taker,
      builderFeesUsd: position.entryBuilderFees + fees.builder,
      fundingUsd: position.fundingAccrued,
      slippageUsd: position.entrySlippageUsd + slipCost,
      netPnlUsd:
        grossPnl -
        (position.entryFees +
          fees.taker +
          position.entryBuilderFees +
          fees.builder) -
        position.fundingAccrued -
        (position.entrySlippageUsd + slipCost),
    };
    trades.push(trade);

    if (reason === "liquidation") {
      liquidations.push({
        barIndex: i,
        time: bars[i].t,
        side,
        price: fillPrice,
        tradeIndex: trades.length - 1,
      });
    }

    position = null;
    cooldownUntil = i + 1 + (risk.cooldownBars || 0);
  }

  function consumePendingAt(i) {
    const due = pending.filter((p) => p.fillBar === i);
    for (let k = pending.length - 1; k >= 0; k--) {
      if (pending[k].fillBar === i) pending.splice(k, 1);
    }
    due.sort((a, b) => {
      const rank = (x) => (x.kind === "exit" ? 0 : 1);
      return rank(a) - rank(b);
    });
    for (const item of due) {
      if (item.kind === "exit") {
        if (!position || position.side !== item.side) continue;
        closePosition(i, bars[i].o, item.reason || "rule", true);
      } else if (item.kind === "entry") {
        if (position) continue;
        if (i < cooldownUntil) continue;
        openPosition(i, item.side, bars[i].o);
      }
    }
  }

  function applyFunding(i) {
    if (!position) return;
    const fr = bars[i].fundingRate;
    if (fr == null || !isFiniteNumber(fr)) return;
    const payment = fr * position.notionalUsd;
    if (position.side === "long") {
      equity -= payment;
      position.fundingAccrued += payment;
      fundingUsd += payment;
    } else {
      equity += payment;
      position.fundingAccrued -= payment;
      fundingUsd -= payment;
    }
  }

  function checkIntrabarExits(i) {
    if (!position) return;
    if (i === position.entryBarIndex) return;
    const bar = bars[i];
    const side = position.side;
    const liqHit = touchesLiq(bar, side, position.liq);
    const stopHit = touchesStop(bar, side, position.stop);
    const takeHit = touchesTake(bar, side, position.take);

    if (liqHit) {
      closePosition(i, position.liq, "liquidation", false);
      return;
    }
    if (stopHit && takeHit) {
      closePosition(i, position.stop, "stop_loss", true);
      return;
    }
    if (stopHit) {
      closePosition(i, position.stop, "stop_loss", true);
      return;
    }
    if (takeHit) {
      closePosition(i, position.take, "take_profit", true);
    }
  }

  for (let i = 0; i < bars.length; i++) {
    consumePendingAt(i);
    checkIntrabarExits(i);
    applyFunding(i);

    const signals = evaluated[i].signals;
    const fillBar = i + latency;

    if (position) {
      const wantExit =
        (position.side === "long" && signals.exitLong === true) ||
        (position.side === "short" && signals.exitShort === true);
      if (wantExit && fillBar < bars.length) {
        const exists = pending.some(
          (p) => p.kind === "exit" && p.side === position.side && p.fillBar === fillBar,
        );
        if (!exists) {
          schedule({
            kind: "exit",
            side: position.side,
            signalBar: i,
            fillBar,
            reason: "rule",
          });
        }
      }
    } else {
      const longSig = signals.entryLong === true;
      const shortSig = signals.entryShort === true;
      if (longSig && shortSig) {
        flags.push({
          type: "conflicting_entry_signals",
          barIndex: i,
          time: bars[i].t,
          message: "conflicting entry signals; no position opened",
        });
      } else if ((longSig || shortSig) && fillBar < bars.length && i >= cooldownUntil) {
        schedule({
          kind: "entry",
          side: longSig ? "long" : "short",
          signalBar: i,
          fillBar,
        });
      }
    }

    equityCurve.push({
      barIndex: i,
      time: bars[i].t,
      equity,
      positionSide: position ? position.side : null,
    });
  }

  if (position) {
    const i = bars.length - 1;
    closePosition(i, bars[i].c, "end_of_data", true);
    equityCurve[i] = {
      barIndex: i,
      time: bars[i].t,
      equity,
      positionSide: null,
    };
  }

  const netPnlUsd = equity - opts.initialEquityUsd;
  const netPnlPct = (netPnlUsd / opts.initialEquityUsd) * 100;
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  for (const t of trades) {
    if (t.netPnlUsd > 0) {
      wins += 1;
      grossWin += t.netPnlUsd;
    } else if (t.netPnlUsd < 0) {
      grossLoss += -t.netPnlUsd;
    }
  }
  const tradeCount = trades.length;
  const winRate = tradeCount === 0 ? 0 : wins / tradeCount;
  let profitFactor = 0;
  if (grossLoss > 0) profitFactor = grossWin / grossLoss;
  else if (grossWin > 0) profitFactor = 1e12;

  const metrics = {
    netPnlUsd,
    netPnlPct,
    maxDrawdownPct: maxDrawdownPct(equityCurve),
    winRate,
    profitFactor,
    tradeCount,
    sharpe: sharpeFromCurve(equityCurve),
    turnoverUsd,
  };

  const config = {
    initialEquityUsd: opts.initialEquityUsd,
    takerFeeBps: opts.takerFeeBps,
    builderFeeBps: opts.builderFeeBps,
    slippageBps: opts.slippageBps,
    latencyBars: opts.latencyBars,
  };

  const result = {
    strategyHash: compiled.strategyHash,
    compilerHash: STRATEGY_COMPILER_HASH,
    compilerVersion: STRATEGY_COMPILER_VERSION,
    config,
    trades,
    equityCurve,
    metrics,
    costs: {
      feesUsd,
      builderFeesUsd,
      fundingUsd,
      slippageUsd,
    },
    liquidations,
    flags,
  };

  return deepFreeze(sortKeysDeep(JSON.parse(JSON.stringify(result))));
}
