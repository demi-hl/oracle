// Deterministic Hyperliquid strategy backtester. No network, keys, clock, I/O, or randomness.

import { createHash } from "node:crypto";
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
  maxVolumeParticipationPct: 100,
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

function assertFiniteNumbers(value, path = "result") {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite backtest result at ${path}`);
    return;
  }
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteNumbers(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assertFiniteNumbers(item, `${path}.${key}`);
  }
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
    for (const [k, val] of [["o", o], ["h", h], ["l", l], ["c", c]]) {
      if (!(val > 0)) throw new TypeError(`bars[${i}].${k} price must be positive`);
    }
    if (v < 0) throw new TypeError(`bars[${i}].v volume must be non-negative`);
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
    if (
      "fundingPaymentRate" in b &&
      b.fundingPaymentRate != null &&
      !isFiniteNumber(b.fundingPaymentRate)
    ) {
      throw new TypeError(`bars[${i}].fundingPaymentRate must be finite when present`);
    }
    if ("openInterest" in b && b.openInterest != null && !isFiniteNumber(b.openInterest)) {
      throw new TypeError(`bars[${i}].openInterest must be finite when present`);
    }
  }
}

export function strategyBarsHash(bars) {
  if (!Array.isArray(bars)) throw new TypeError("bars must be an array");
  if (bars.length > 0) assertBars(bars);
  return createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(bars)), "utf8")
    .digest("hex");
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
    "maxVolumeParticipationPct",
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
      if (feeKey === "slippageBps" ? v >= 10_000 : v > 10_000) {
        throw new TypeError(`${feeKey} exceeds its safe basis-point bound`);
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
  if ("maxVolumeParticipationPct" in options) {
    const v = options.maxVolumeParticipationPct;
    if (!isFiniteNumber(v) || v <= 0 || v > 100) {
      throw new TypeError("maxVolumeParticipationPct must be in (0,100]");
    }
    out.maxVolumeParticipationPct = v;
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

function liqPrice(entry, side, leverage, feeBps) {
  if (!(leverage > 0)) return side === "long" ? 0 : Number.POSITIVE_INFINITY;
  const maintenanceRate = Math.min(0.99, 1 / (2 * leverage) + feeBps / 10_000);
  return side === "long"
    ? (entry * (1 - 1 / leverage)) / (1 - maintenanceRate)
    : (entry * (1 + 1 / leverage)) / (1 + maintenanceRate);
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

export function assertStrategyRequiredSeries(compiled, bars) {
  for (const field of compiled.requiredSeries) {
    if (!["fundingRate", "openInterest"].includes(field)) continue;
    if (!bars.every((bar) => isFiniteNumber(bar?.[field]))) {
      throw new Error(`strategy required series is absent: ${field}`);
    }
  }
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
  const barsHash = strategyBarsHash(bars);

  if (opts.nowMs !== undefined) {
    normalizeStrategy(strategyInput, { nowMs: opts.nowMs });
  }

  const compiled = compileStrategy(strategyInput);
  assertStrategyRequiredSeries(compiled, bars);
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
  const missedFills = [];
  const flags = [];
  const equityCurve = [];

  let position = null;
  let exposureBars = 0;
  let dayKey = null;
  let dayStartEquity = equity;
  let dayLossBlocked = false;
  let cooldownUntil = 0;
  let lifecycleEpoch = 0;
  const pending = [];
  const filledVolumeByBar = new Array(bars.length).fill(0);

  function schedule(item) {
    pending.push(item);
  }

  function remainingFillVolume(i) {
    const limit = bars[i].v * (opts.maxVolumeParticipationPct / 100);
    return Math.max(0, limit - filledVolumeByBar[i]);
  }

  function markedEquityAt(price) {
    if (!position) return equity;
    const unrealized =
      position.side === "long"
        ? (price - position.entryPrice) * position.qty
        : (position.entryPrice - price) * position.qty;
    return equity + unrealized;
  }

  function openPosition(i, side, fillBar) {
    const rawOpen = fillBar.o;
    const notional = computeNotional(equity, risk);
    if (!(notional > 0) || !(rawOpen > 0)) return;
    const fill = applyEntrySlippage(rawOpen, side, slipBps);
    const qty = notional / fill;
    const remainingVolume = remainingFillVolume(i);
    const maxFillNotional = fill * remainingVolume;
    if (qty > remainingVolume) {
      missedFills.push({
        kind: "entry",
        barIndex: i,
        time: fillBar.t,
        side,
        requestedNotionalUsd: notional,
        maxFillNotionalUsd: maxFillNotional,
        reason: "volume_participation",
      });
      return;
    }
    filledVolumeByBar[i] += qty;
    const slipCost = Math.abs(fill - rawOpen) * qty;
    const fees = feeOnNotional(notional, takerBps, builderBps);

    equity -= fees.total;
    feesUsd += fees.taker;
    builderFeesUsd += fees.builder;
    slippageUsd += slipCost;
    turnoverUsd += notional;

    const positionEpoch = ++lifecycleEpoch;
    position = {
      lifecycleEpoch: positionEpoch,
      side,
      entryBarIndex: i,
      entryReferencePrice: rawOpen,
      entryPrice: fill,
      qty,
      notionalUsd: notional,
      stop: stopPrice(fill, side, risk.stopLossPct),
      take: takePrice(fill, side, risk.takeProfitPct),
      liq: liqPrice(fill, side, risk.maxLeverage, takerBps + builderBps),
      entryFees: fees.taker,
      entryBuilderFees: fees.builder,
      entrySlippageUsd: slipCost,
      fundingAccrued: 0,
    };
  }

  function closePosition(i, rawPrice, reason, applySlip) {
    if (!position) return false;
    const side = position.side;
    const reference = rawPrice;

    let fillPrice = reference;
    if (reason !== "liquidation" && applySlip) {
      fillPrice = applyExitSlippage(reference, side, slipBps);
    }

    const qty = position.qty;
    const exitNotional = qty * fillPrice;
    if (reason !== "liquidation") {
      const remainingVolume = remainingFillVolume(i);
      const maxFillNotional = fillPrice * remainingVolume;
      if (qty > remainingVolume) {
        missedFills.push({
          kind: "exit",
          barIndex: i,
          time: bars[i].t,
          side,
          requestedNotionalUsd: exitNotional,
          maxFillNotionalUsd: maxFillNotional,
          reason: "volume_participation",
          triggerReason: reason,
        });
        return false;
      }
      filledVolumeByBar[i] += qty;
    }
    const fees = feeOnNotional(exitNotional, takerBps, builderBps);
    const slipCost =
      reason === "liquidation" ? 0 : Math.abs(fillPrice - reference) * qty;

    let grossPnl;
    let actualPnl;
    if (side === "long") {
      grossPnl = (reference - position.entryReferencePrice) * qty;
      actualPnl = (fillPrice - position.entryPrice) * qty;
    } else {
      grossPnl = (position.entryReferencePrice - reference) * qty;
      actualPnl = (position.entryPrice - fillPrice) * qty;
    }

    equity += actualPnl;
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
    lifecycleEpoch += 1;
    cooldownUntil = i + 1 + (risk.cooldownBars || 0);
    return true;
  }

  function scheduleExitRetry(i, side, reason, epoch) {
    const fillBar = i + 1;
    if (fillBar >= bars.length) return;
    const exists = pending.some(
      (item) =>
        item.kind === "exit" &&
        item.side === side &&
        item.fillBar === fillBar &&
        item.epoch === epoch,
    );
    if (!exists) schedule({ kind: "exit", side, signalBar: i, fillBar, reason, epoch });
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
        if (
          !position ||
          position.side !== item.side ||
          position.lifecycleEpoch !== item.epoch
        ) continue;
        const reason = item.reason || "rule";
        if (!closePosition(i, bars[i].o, reason, true)) {
          scheduleExitRetry(i, item.side, reason, item.epoch);
        }
      } else if (item.kind === "entry") {
        if (position) continue;
        if (item.epoch !== lifecycleEpoch) continue;
        if (i < cooldownUntil) continue;
        openPosition(i, item.side, bars[i]);
      }
    }
  }

  function applyFunding(i) {
    if (!position) return;
    const bar = bars[i];
    const fr = bar.fundingPaymentRate;
    if (fr == null || !isFiniteNumber(fr) || fr === 0) return;
    const markedNotionalUsd = Math.abs(position.qty * bar.c);
    const payment = fr * markedNotionalUsd;
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

  function checkOpenLiquidation(i) {
    if (!position) return;
    const open = bars[i].o;
    const hit = position.side === "long" ? open <= position.liq : open >= position.liq;
    if (hit) closePosition(i, open, "liquidation", false);
  }

  function checkIntrabarExits(i) {
    if (!position) return;
    const bar = bars[i];
    const side = position.side;
    const liqHit = touchesLiq(bar, side, position.liq);
    const stopHit = touchesStop(bar, side, position.stop);
    const takeHit = touchesTake(bar, side, position.take);
    const adverseGap = (trigger) =>
      side === "long" ? Math.min(trigger, bar.o) : Math.max(trigger, bar.o);

    if (liqHit) {
      closePosition(i, adverseGap(position.liq), "liquidation", false);
      return;
    }
    if (stopHit && takeHit) {
      if (!closePosition(i, adverseGap(position.stop), "stop_loss", true)) {
        scheduleExitRetry(i, side, "stop_loss", position.lifecycleEpoch);
      }
      return;
    }
    if (stopHit) {
      if (!closePosition(i, adverseGap(position.stop), "stop_loss", true)) {
        scheduleExitRetry(i, side, "stop_loss", position.lifecycleEpoch);
      }
      return;
    }
    if (takeHit) {
      if (!closePosition(i, position.take, "take_profit", true)) {
        scheduleExitRetry(i, side, "take_profit", position.lifecycleEpoch);
      }
    }
  }

  for (let i = 0; i < bars.length; i++) {
    const nextDayKey = Math.floor(bars[i].t / 86_400_000);
    if (nextDayKey !== dayKey) {
      dayKey = nextDayKey;
      dayStartEquity = markedEquityAt(bars[i].o);
      dayLossBlocked = false;
    }

    checkOpenLiquidation(i);
    consumePendingAt(i);
    checkIntrabarExits(i);
    applyFunding(i);

    if (
      !dayLossBlocked &&
      markedEquityAt(bars[i].c) <=
        dayStartEquity * (1 - risk.maxDailyLossPct / 100)
    ) {
      dayLossBlocked = true;
      flags.push({
        type: "daily_loss_limit",
        barIndex: i,
        time: bars[i].t,
        message: "daily loss limit reached; new entries blocked for UTC day",
      });
    }

    const signals = evaluated[i].signals;
    const fillBar = i + latency;

    if (position) {
      const wantExit =
        (position.side === "long" && signals.exitLong === true) ||
        (position.side === "short" && signals.exitShort === true);
      if (wantExit && fillBar < bars.length) {
        const exists = pending.some(
          (p) =>
            p.kind === "exit" &&
            p.side === position.side &&
            p.fillBar === fillBar &&
            p.epoch === position.lifecycleEpoch,
        );
        if (!exists) {
          schedule({
            kind: "exit",
            side: position.side,
            signalBar: i,
            fillBar,
            reason: "rule",
            epoch: position.lifecycleEpoch,
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
      } else if (
        !dayLossBlocked &&
        (longSig || shortSig) &&
        fillBar < bars.length &&
        i >= cooldownUntil
      ) {
        schedule({
          kind: "entry",
          side: longSig ? "long" : "short",
          signalBar: i,
          fillBar,
          epoch: lifecycleEpoch,
        });
      }
    }

    let markedEquity = equity;
    if (position) {
      exposureBars += 1;
      markedEquity = markedEquityAt(bars[i].c);
    }
    equityCurve.push({
      barIndex: i,
      time: bars[i].t,
      equity: markedEquity,
      positionSide: position ? position.side : null,
    });
  }

  let openPositionAtEnd = null;
  if (position) {
    const i = bars.length - 1;
    const closed = closePosition(i, bars[i].c, "end_of_data", true);
    if (closed) {
      equityCurve[i] = {
        barIndex: i,
        time: bars[i].t,
        equity,
        positionSide: null,
      };
    } else {
      const markedEquityUsd = markedEquityAt(bars[i].c);
      openPositionAtEnd = {
        side: position.side,
        entryBarIndex: position.entryBarIndex,
        entryTime: bars[position.entryBarIndex].t,
        entryPrice: position.entryPrice,
        qty: position.qty,
        notionalUsd: position.notionalUsd,
        markPrice: bars[i].c,
        markedEquityUsd,
      };
      flags.push({
        type: "open_position_at_end",
        barIndex: i,
        time: bars[i].t,
        message: "end-of-data exit missed; position remains open and marked",
      });
    }
  }

  const finalEquity = position
    ? markedEquityAt(bars[bars.length - 1].c)
    : equity;
  const netPnlUsd = finalEquity - opts.initialEquityUsd;
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
    exposurePct: (exposureBars / bars.length) * 100,
  };

  const config = {
    initialEquityUsd: opts.initialEquityUsd,
    takerFeeBps: opts.takerFeeBps,
    builderFeeBps: opts.builderFeeBps,
    slippageBps: opts.slippageBps,
    latencyBars: opts.latencyBars,
    maxVolumeParticipationPct: opts.maxVolumeParticipationPct,
  };

  const result = {
    barsHash,
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
    missedFills,
    openPositionAtEnd,
    flags,
  };

  assertFiniteNumbers(result);
  return deepFreeze(sortKeysDeep(result));
}
