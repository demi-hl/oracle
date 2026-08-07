// TWAP (time-weighted average price) DCA execution engine.
//
// Splits a single large order into equal-sized chunks spaced evenly over a
// configurable window. Each chunk executes independently; the aggregator
// uses the best available route at execution time rather than locking in
// a single venue upfront.
//
// Custody: prepare-only. Every chunk is an unsigned transaction artifact.
// This module never signs, never broadcasts, never touches key material.

import { bestSwapRoute } from "../../router/index.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

const MIN_SPLITS = 2;
const MAX_SPLITS = 100;
const MIN_WINDOW_SEC = 60;       // 1 minute
const DEFAULT_SPLITS = 10;
const DEFAULT_WINDOW_HOURS = 6;

/**
 * Validate and normalize TWAP parameters.
 * @param {{ amount: string|bigint, chainId: number, tokenIn: string, tokenOut: string, splits?: number, windowHours?: number, taker: string, slippageBps?: number }} params
 */
export function normalizeTwapParams(params = {}) {
  const splits = Math.max(MIN_SPLITS, Math.min(MAX_SPLITS, Number(params.splits) || DEFAULT_SPLITS));
  const windowHours = Math.max(0.1, Number(params.windowHours) || DEFAULT_WINDOW_HOURS);
  const windowSec = Math.max(MIN_WINDOW_SEC, windowHours * 3600);
  const chunkSize = BigInt(params.amount) / BigInt(splits);
  const intervalSec = Math.floor(windowSec / splits);
  const slippageBps = Number(params.slippageBps) || 100;

  if (!params.chainId) throw new Error("twap requires chainId");
  if (!params.tokenIn || !params.tokenOut) throw new Error("twap requires tokenIn and tokenOut");
  if (!params.taker) throw new Error("twap requires taker address");
  if (BigInt(params.amount) <= 0n) throw new Error("twap amount must be positive");

  return {
    chainId: Number(params.chainId),
    tokenIn: String(params.tokenIn),
    tokenOut: String(params.tokenOut),
    amount: String(params.amount),
    splits,
    chunkSize: String(chunkSize),
    windowHours,
    windowSec,
    intervalSec,
    taker: String(params.taker),
    slippageBps,
    status: "planned",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Generate the split schedule. Returns an array of { splitIndex, executeAfter (ISO), chunkSize }.
 */
export function buildTwapSchedule(params) {
  const p = normalizeTwapParams(params);
  const now = Math.floor(Date.now() / 1000);
  const schedule = [];
  for (let i = 0; i < p.splits; i++) {
    schedule.push({
      splitIndex: i + 1,
      executeAfter: new Date((now + i * p.intervalSec) * 1000).toISOString(),
      chunkSize: p.chunkSize,
    });
  }
  return { params: p, schedule };
}

/**
 * Prepare a single TWAP chunk — quote + unsigned swap artifact.
 * Same custody contract as oracle swap: requiresWalletSignature, backendSigner false.
 */
export async function prepareTwapChunk(twap, splitIndex, { chainId, tokenIn, tokenOut, chunkSize, taker, slippageBps } = twap.params) {
  if (splitIndex < 1 || splitIndex > twap.params.splits) {
    throw new Error(`splitIndex ${splitIndex} out of range 1-${twap.params.splits}`);
  }
  const route = await bestSwapRoute({
    chainId,
    tokenIn,
    tokenOut,
    amountIn: chunkSize,
    taker,
  });

  const prepared = stampPrepared(route.transaction ?? route.tx, {
    chainId,
    taker,
    tokenIn,
    tokenOut,
    amountIn: chunkSize,
    slippageBps,
    kind: "twap",
    splitIndex,
    totalSplits: twap.params.splits,
  });

  return {
    splitIndex,
    chunkSize,
    quote: {
      amountOut: route.amountOut ?? route.quote?.amountOut,
      source: route.source ?? route.venue,
      priceImpact: route.priceImpact,
    },
    ...prepared,
  };
}

/**
 * Simulate a full TWAP run: quote every chunk at current prices.
 * Used for preview/planning; does NOT prepare transactions.
 */
export async function simulateTwap(params, { quoteFn = bestSwapRoute } = {}) {
  const plan = buildTwapSchedule(params);
  const chunks = [];
  let totalOut = 0n;
  let bestSource = "unknown";

  for (let i = 0; i < plan.params.splits; i++) {
    try {
      const q = await quoteFn({
        chainId: plan.params.chainId,
        tokenIn: plan.params.tokenIn,
        tokenOut: plan.params.tokenOut,
        amountIn: plan.params.chunkSize,
        taker: plan.params.taker,
      });
      const out = BigInt(q.amountOut ?? q.quote?.amountOut ?? "0");
      totalOut += out;
      bestSource = q.source ?? q.venue ?? bestSource;
      chunks.push({ splitIndex: i + 1, amountOut: String(out), source: q.source ?? q.venue });
    } catch (e) {
      chunks.push({ splitIndex: i + 1, error: String(e.message || e).slice(0, 200) });
    }
  }

  const averagePrice = totalOut > 0n
    ? (Number(totalOut) / Number(BigInt(plan.params.amount))).toFixed(6)
    : null;

  return {
    params: plan.params,
    schedule: plan.schedule,
    totalOut: String(totalOut),
    averagePrice,
    bestSource,
    chunks,
    simulatedAt: new Date().toISOString(),
  };
}
