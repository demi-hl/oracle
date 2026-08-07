// Source adapters for the best-execution router.
//
// Each aggregator returns a different shape and means slightly different things by
// the same words. This module is where those differences are made explicit instead
// of being papered over by a shared field name.
//
// Notable disagreements handled here:
//   * LI.FI reports gas AND fee costs already denominated in USD
//   * 0x returns totalNetworkFee in native wei -- needs a native price to compare
//   * 1inch quote returns only dstAmount + gas units, no cost
//   * CoW is an intent: the solver pays gas, so gasUsd is genuinely 0, not unknown
//   * Odos/ParaSwap report USD-valued gas estimates directly
//
// Sources needing an API key are skipped when the key is absent rather than throwing.
// A missing optional key is a config state, not an error, and must not sink the
// comparison.

import { lifiQuote } from "../data/providers/lifi.mjs";
import { paraswapPrice } from "../data/providers/paraswap.mjs";
import { zeroxQuote } from "../data/providers/zerox.mjs";
import { oneinchQuote } from "../data/providers/oneinch.mjs";
import { cowQuote } from "../data/providers/cowswap.mjs";
import { uniV3QuoteExactIn, UNI_V3_CHAINS } from "../data/providers/uniswap-v3.mjs";
import { uniV4QuoteExactIn, UNI_V4_CHAINS } from "../data/providers/uniswap-v4.mjs";
import { llamaPrices } from "../data/providers/defillama.mjs";
import { NATIVE_PRICE_KEY } from "./best-execution.mjs";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Sum a LI.FI-style cost array that carries amountUSD entries. */
function sumUsd(list) {
  if (!Array.isArray(list)) return null;
  let total = 0;
  let sawAny = false;
  for (const c of list) {
    const v = num(c?.amountUSD);
    if (v != null) {
      total += v;
      sawAny = true;
    }
  }
  return sawAny ? total : null;
}

/** Fetch the native asset's USD price, for sources that price gas in wei. */
export async function nativeUsd(chainId, opts = {}) {
  const key = NATIVE_PRICE_KEY[Number(chainId)];
  if (!key) return null;
  try {
    const res = await llamaPrices([key], opts);
    return num(res?.coins?.[key]?.price);
  } catch {
    return null;
  }
}

/**
 * Build the candidate list for a same-chain swap.
 *
 * @returns {Array<{source: string, run: () => Promise<object>}>}
 */
export function swapCandidates({
  chainId,
  tokenIn,
  tokenOut,
  amountIn,
  taker,
  slippageBps,
  decimalsIn,
  decimalsOut,
  nativePriceUsd = null,
  destDecimalsPromise = null,
  opts = {},
}) {
  const c = [];

  c.push({
    source: "lifi",
    run: async () => {
      const q = await lifiQuote(
        { fromChain: chainId, toChain: chainId, fromToken: tokenIn, toToken: tokenOut, fromAmount: amountIn },
        opts,
      );
      const est = q?.estimate ?? q?.[0]?.estimate;
      return {
        amountOut: est?.toAmount,
        minOut: est?.toAmountMin,
        gasUsd: sumUsd(est?.gasCosts),
        feeUsd: sumUsd(est?.feeCosts),
        meta: { tool: q?.tool ?? q?.toolDetails?.name },
      };
    },
  });

  // Odos is deliberately NOT in this list: its public SOR API was sunset on
  // 2026-07-30 and returns HTTP 410. Querying it would spend a timeout on every
  // single swap comparison to learn a fact we already know. src/data/providers/odos.mjs
  // is kept for callers that still reference it, and re-adding it here is a one-line
  // change if Odos ships a replacement endpoint.

  // ParaSwap needs decimals for BOTH sides to quote at all.
  //
  // decimalsOut may arrive from the caller or from the destination price lookup,
  // which now resolves in parallel rather than before this list is built. So the
  // gate is decimalsIn (caller-only), and decimalsOut is resolved inside run().
  //
  // Subtle regression this avoids: gating on a value that is no longer awaited here
  // would silently DROP ParaSwap for every caller who did not pass decimalsOut --
  // quietly shrinking the comparison from three sources to two while still reporting
  // a "best" route.
  if (decimalsIn != null) {
    c.push({
      source: "paraswap",
      run: async () => {
        const dOut = decimalsOut ?? (await Promise.resolve(destDecimalsPromise))?.decimals;
        if (dOut == null) {
          throw new Error("paraswap needs destination decimals; none supplied or resolvable");
        }
        const q = await paraswapPrice(
          { chainId, srcToken: tokenIn, destToken: tokenOut, amount: amountIn, srcDecimals: decimalsIn, destDecimals: dOut },
          opts,
        );
        const pr = q?.priceRoute;
        return {
          amountOut: pr?.destAmount,
          gasUsd: num(pr?.gasCostUSD),
          meta: { bestRoute: pr?.bestRoute?.[0]?.swaps?.[0]?.swapExchanges?.[0]?.exchange },
        };
      },
    });
  }

  // 0x and 1inch need keys. Skip silently when absent -- see module header.
  if (process.env.ZEROX_API_KEY) {
    c.push({
      source: "0x",
      run: async () => {
        const q = await zeroxQuote({ chainId, sellToken: tokenIn, buyToken: tokenOut, sellAmount: amountIn, taker }, opts);
        // totalNetworkFee is native wei; convert only if we have a price.
        // nativePriceUsd may be a PROMISE: prices are fetched in parallel with the
        // quotes rather than before them. Awaiting here means only the one adapter
        // that actually needs it pays for it, and only after its own HTTP call.
        let gasUsd = null;
        const feeWei = q?.totalNetworkFee;
        const nativePrice = await Promise.resolve(nativePriceUsd);
        if (feeWei != null && nativePrice) {
          gasUsd = (Number(feeWei) / 1e18) * nativePrice;
        }
        return { amountOut: q?.buyAmount, minOut: q?.minBuyAmount, gasUsd, meta: { source: q?.route?.fills?.[0]?.source } };
      },
    });
  }

  if (process.env.ONEINCH_API_KEY) {
    c.push({
      source: "1inch",
      run: async () => {
        const q = await oneinchQuote({ chainId, src: tokenIn, dst: tokenOut, amount: amountIn }, opts);
        let gasUsd = null;
        if (q?.gas != null && nativePriceUsd) {
          // 1inch returns gas UNITS; without a gas price this stays unknown rather
          // than being guessed. Reporting a made-up cost is worse than reporting none.
          gasUsd = null;
        }
        return { amountOut: q?.dstAmount, gasUsd, meta: { gasUnits: q?.gas } };
      },
    });
  }

  // CoW is an intent, not a transaction: a solver executes and eats the gas, so the
  // user pays 0 gas. That is a MEASURED zero, not an unknown, and it is exactly the
  // case naive "biggest number wins" ranking gets wrong -- CoW often quotes slightly
  // lower gross while winning decisively on net.
  c.push({
    source: "cow",
    run: async () => {
      const q = await cowQuote(
        { chainId, sellToken: tokenIn, buyToken: tokenOut, sellAmountBeforeFee: String(amountIn), from: taker },
        opts,
      );
      const quote = q?.quote ?? q;
      const feeAmount = quote?.feeAmount;
      return {
        amountOut: quote?.buyAmount,
        gasUsd: 0,
        meta: { intent: true, feeAmountInSellToken: feeAmount, settlement: "solver-executed" },
      };
    },
  });

  // On-chain Uniswap V3 QuoterV2. UNLIKE every other source in this list, this is
  // not a third-party API — it is an eth_call against the chain itself.
  //
  // Why it exists here: aggregators only index chains they chose to support. On
  // Robinhood Chain (4663) LI.FI/ParaSwap/CoW all return nothing, so the candidate
  // list came back empty and the router reported "no usable route" — which reads
  // like a permission wall but is really zero coverage. A chain with a live V3
  // deployment can always be priced directly, with no API key and no indexer.
  //
  // Kept LAST so it acts as a floor: when aggregators do cover a chain they usually
  // win on route quality, and best-execution still compares net output. This only
  // decides the trade when it is the sole source that answered.
  //
  // Read-only. quoteExactInputSingle is a view call; this cannot sign or broadcast.
  if (UNI_V3_CHAINS[Number(chainId)]) {
    c.push({
      source: "uniswap-v3",
      run: async () => {
        const q = await uniV3QuoteExactIn(
          { chainId, tokenIn, tokenOut, amountIn },
          opts,
        );
        // Gas is deliberately null, not 0: the quoter returns a gasEstimate in UNITS,
        // and without a gas price that is not a USD cost. Reporting 0 would make this
        // source look free and beat correctly-priced aggregators. See CoW above for
        // the one case where 0 is a measured fact rather than a missing number.
        return {
          amountOut: q?.amountOut,
          minOut: q?.minOut ?? q?.amountOutMinimum ?? null,
          gasUsd: null,
          meta: { onchain: true, fee: q?.fee, gasUnits: q?.gasEstimate, quoter: q?.quoter },
        };
      },
    });
  }

  // Uniswap V4 Quoter. Cross-chain floor alongside V3. On RH the live SQUEEZE book
  // is V4; V3 alone can return a drained shell that looks like a real quote. Kept
  // after V3 so best-execution still compares net output when both answer.
  if (UNI_V4_CHAINS[Number(chainId)]) {
    c.push({
      source: "uniswap-v4",
      run: async () => {
        const q = await uniV4QuoteExactIn(
          { chainId, tokenIn, tokenOut, amountIn, recipient: taker, slippageBps },
          opts,
        );
        return {
          amountOut: q?.amountOut,
          minOut: q?.minOut ?? q?.amountOutMinimum ?? null,
          gasUsd: null,
          meta: {
            onchain: true,
            venue: "uniswap-v4",
            fee: q?.fee,
            tickSpacing: q?.tickSpacing,
            poolId: q?.poolId,
            hooks: q?.hooks,
            gasUnits: q?.gasEstimate,
            quoter: q?.quoter,
            poolManager: q?.poolManager,
            prepareReady: q?.prepareReady === true,
            executionReady: false,
          },
        };
      },
    });
  }

  return c;
}

/**
 * Build the candidate list for a cross-chain bridge.
 *
 * Bridging has a cost structure swaps do not: a relayer fee, a destination-gas
 * component, and a time-to-finality that is itself a cost. A route that saves $2 and
 * takes 30 minutes is not obviously better than one that costs $2 more and lands in
 * 20 seconds, so duration is surfaced rather than collapsed into the score.
 */
export function bridgeCandidates({
  fromChainId,
  toChainId,
  tokenIn,
  tokenOut,
  amountIn,
  taker,
  opts = {},
}) {
  const c = [];

  c.push({
    source: "lifi",
    run: async () => {
      const q = await lifiQuote(
        { fromChain: fromChainId, toChain: toChainId, fromToken: tokenIn, toToken: tokenOut, fromAmount: amountIn },
        opts,
      );
      const est = q?.estimate ?? q?.[0]?.estimate;
      return {
        amountOut: est?.toAmount,
        minOut: est?.toAmountMin,
        gasUsd: sumUsd(est?.gasCosts),
        feeUsd: sumUsd(est?.feeCosts),
        meta: {
          tool: q?.tool ?? q?.toolDetails?.name,
          durationSeconds: num(est?.executionDuration),
        },
      };
    },
  });

  c.push({
    source: "relay",
    run: async () => {
      const { relayQuote } = await import("../data/providers/bridges.mjs");
      const q = await relayQuote(
        {
          user: taker,
          originChainId: fromChainId,
          destinationChainId: toChainId,
          originCurrency: tokenIn,
          destinationCurrency: tokenOut,
          amount: String(amountIn),
        },
        opts,
      );
      const d = q?.details;
      return {
        amountOut: d?.currencyOut?.amount,
        minOut: d?.currencyOut?.minimumAmount,
        gasUsd: num(d?.totalImpact?.usd) != null ? Math.abs(num(d.totalImpact.usd)) : null,
        meta: { durationSeconds: num(d?.timeEstimate), rate: d?.rate },
      };
    },
  });

  c.push({
    source: "across",
    run: async () => {
      const { acrossSuggestedFees } = await import("../data/providers/bridges.mjs");
      const q = await acrossSuggestedFees(
        { token: tokenIn, destinationToken: tokenOut, originChainId: fromChainId, destinationChainId: toChainId, amount: String(amountIn) },
        opts,
      );
      // Across returns fees, not an output amount: derive output as input - fees so it
      // is comparable with sources that quote an output directly.
      const totalFee = q?.totalRelayFee?.total;
      let amountOut = null;
      if (totalFee != null) {
        try {
          const outWei = BigInt(String(amountIn)) - BigInt(String(totalFee));
          if (outWei > 0n) amountOut = outWei.toString();
        } catch {
          /* leave null -- a failed derivation must not become a fabricated number */
        }
      }
      return {
        amountOut,
        gasUsd: null,
        meta: {
          derivedFromFees: true,
          durationSeconds: num(q?.estimatedFillTimeSec),
          limits: q?.limits ? { min: q.limits.minDeposit, max: q.limits.maxDeposit } : undefined,
        },
      };
    },
  });

  return c;
}
