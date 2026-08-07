// Uniswap V3 venue adapter.
//
// The V2 adapter cannot be bent to cover V3: V3 has no getAmountsOut, prices through
// a separate Quoter contract, and requires an explicit fee tier per hop. Encoding a
// V3 swap with V2 assumptions produces a transaction that looks plausible and
// reverts -- or worse, routes through the wrong pool. So this is a sibling adapter,
// as docs/adding-a-chain.md prescribes.
//
// Custody is unchanged: quotes are eth_call, prepare returns an UNSIGNED tx, and
// nothing in this module can sign or broadcast.

import { rpcCall } from "../data/providers/evm-rpc.mjs";
import { EVIDENCE, RISK } from "./contract.mjs";

// Standard V3 fee tiers, cheapest first. 100 (0.01%) exists mainly for stable pairs.
export const FEE_TIERS = [100, 500, 3000, 10000];

const SEL = {
  // QuoterV2.quoteExactInputSingle((address,address,uint256,uint24,uint160))
  quoteExactInputSingle: "c6a5026a",
  // SwapRouter02.exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  exactInputSingle: "04e45aaf",
};

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const MAX_SLIPPAGE_BPS = 100;

export function applySlippage(amountOut, slippageBps) {
  const bps = Number(slippageBps);
  if (!Number.isFinite(bps) || bps < 0) {
    throw new Error("slippageBps must be a non-negative number");
  }
  if (bps > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `slippageBps ${bps} exceeds the ${MAX_SLIPPAGE_BPS} bps ceiling. ` +
        "Block and requote or split the order -- do not widen the guard to force a fill.",
    );
  }
  return (BigInt(amountOut) * BigInt(10_000 - Math.floor(bps))) / 10_000n;
}

function venueOf(scanner, kind) {
  return (scanner?.venues || []).find((v) => v.kind === kind)?.address ?? null;
}

/**
 * Build V3 capabilities for a chain with a verified quoter + router.
 *
 * @param {object} cfg
 * @param {number} cfg.chainId
 * @param {string} [cfg.wrappedNative]
 */
export function v3VenueCapabilities(cfg) {
  const { chainId, wrappedNative } = cfg;

  /** Quote one fee tier. Returns null when that tier has no usable pool. */
  async function quoteTier({ quoter, tokenIn, tokenOut, amountIn, fee }, opts) {
    const data =
      `0x${SEL.quoteExactInputSingle}` +
      addrWord(tokenIn) +
      addrWord(tokenOut) +
      word(amountIn) +
      word(fee) +
      word(0); // sqrtPriceLimitX96 = 0, no limit

    const r = await rpcCall(chainId, "eth_call", [{ to: quoter, data }, "latest"], opts).catch(
      () => null,
    );
    const raw = r?.result ?? r;
    if (!raw || raw === "0x" || raw.length < 66) return null;
    const out = BigInt(`0x${raw.slice(2, 66)}`);
    return out > 0n ? out : null;
  }

  /**
   * Try every fee tier and keep the best.
   *
   * Necessary rather than a nicety: liquidity for a given pair concentrates in one
   * tier, and which tier varies by pair and chain. Guessing 0.3% because it is the
   * common default silently misprices stable pairs and exotic pairs alike.
   */
  async function bestQuote({ quoter, tokenIn, tokenOut, amountIn }, opts) {
    const tried = [];
    let best = null;

    for (const fee of FEE_TIERS) {
      const out = await quoteTier({ quoter, tokenIn, tokenOut, amountIn, fee }, opts);
      tried.push({ fee, amountOut: out ? out.toString() : null });
      if (out && (!best || out > best.amountOut)) best = { fee, amountOut: out };
    }
    return { best, tried };
  }

  return {
    async quote({ tokenIn, tokenOut, amountIn }, opts = {}) {
      const quoter = venueOf(opts.scanner, "quoter");
      if (!quoter) {
        return {
          chainId,
          evidence: EVIDENCE.UNAVAILABLE,
          reason:
            "no verified quoter configured for this chain; quoting stays fail-closed " +
            "rather than guessing a venue address",
        };
      }
      for (const a of [tokenIn, tokenOut]) {
        if (!ADDRESS_RE.test(a || "")) throw new Error("quote requires valid 20-byte addresses");
      }

      const { best, tried } = await bestQuote({ quoter, tokenIn, tokenOut, amountIn }, opts);
      if (!best) {
        return {
          chainId,
          quoter,
          tokenIn,
          tokenOut,
          triedFeeTiers: tried,
          evidence: EVIDENCE.UNKNOWN,
          reason: "no fee tier returned a quote -- no V3 pool for this pair, or no liquidity",
        };
      }

      return {
        chainId,
        venue: "uniswap-v3",
        quoter,
        tokenIn,
        tokenOut,
        amountIn: String(amountIn),
        amountOut: best.amountOut.toString(),
        fee: best.fee,
        triedFeeTiers: tried,
        evidence: EVIDENCE.LIVE,
        note: "exact-input single-hop quote at current tick; not a guaranteed fill",
      };
    },

    /**
     * Round trip: buy the token with the base asset, then sell it back.
     *
     * Same reasoning as the V2 adapter -- a clean buy quote proves nothing about the
     * exit, and a token you cannot sell is the most expensive kind of mistake.
     */
    async sellSimulation({ token, amountIn, base }, opts = {}) {
      const quoter = venueOf(opts.scanner, "quoter");
      const quoteBase = base || wrappedNative;

      // The round trip needs a DIFFERENT asset on the other side. When the token
      // under test IS the base asset, the probe would quote WETH->WETH, which no
      // pool prices, and report FAIL on the most liquid token on the chain.
      // Sellability of the wrapped native is not in question; say so honestly
      // instead of inventing a honeypot signal.
      if (quoteBase && String(token).toLowerCase() === String(quoteBase).toLowerCase()) {
        return {
          chainId,
          token,
          verdict: RISK.UNKNOWN,
          evidence: EVIDENCE.UNAVAILABLE,
          reason:
            "token is the base asset for this chain, so there is nothing to round-trip " +
            "against. Sellability must be judged against a different quote asset.",
        };
      }

      if (!quoter || !quoteBase) {
        return {
          chainId,
          token,
          verdict: RISK.UNKNOWN,
          evidence: EVIDENCE.UNAVAILABLE,
          reason: quoter
            ? "no wrappedNative configured, so there is no base asset to round-trip against"
            : "no verified quoter configured for this chain",
        };
      }

      const buy = await bestQuote(
        { quoter, tokenIn: quoteBase, tokenOut: token, amountIn },
        opts,
      );
      if (!buy.best) {
        return {
          chainId,
          token,
          verdict: RISK.FAIL,
          evidence: EVIDENCE.LIVE,
          leg: "buy",
          reason: "no V3 pool priced the buy leg on any fee tier",
        };
      }

      const sell = await bestQuote(
        { quoter, tokenIn: token, tokenOut: quoteBase, amountIn: buy.best.amountOut },
        opts,
      );
      if (!sell.best) {
        return {
          chainId,
          token,
          verdict: RISK.FAIL,
          evidence: EVIDENCE.LIVE,
          leg: "sell",
          bought: buy.best.amountOut.toString(),
          reason:
            "SELL LEG FAILED while the buy leg quoted fine. This is the honeypot " +
            "signature: do not trade.",
        };
      }

      const returned = sell.best.amountOut;
      const retentionBps = Number((returned * 10_000n) / BigInt(amountIn));

      let verdict = RISK.PASS;
      let reason = "round trip completes with expected fee/impact loss";
      if (retentionBps < 5_000) {
        verdict = RISK.FAIL;
        reason = `round trip returns only ${(retentionBps / 100).toFixed(2)}% -- punitive tax or no real liquidity`;
      } else if (retentionBps < 9_000) {
        verdict = RISK.CAUTION;
        reason = `round trip returns ${(retentionBps / 100).toFixed(2)}% -- transfer tax or thin liquidity at this size`;
      }

      return {
        chainId,
        venue: "uniswap-v3",
        token,
        base: quoteBase,
        verdict,
        reason,
        amountIn: String(amountIn),
        bought: buy.best.amountOut.toString(),
        returned: returned.toString(),
        retentionBps,
        buyFee: buy.best.fee,
        sellFee: sell.best.fee,
        evidence: EVIDENCE.LIVE,
        note: "Quote-level round trip. It does not prove transfer hooks absent at execution time.",
      };
    },

    /**
     * Build an UNSIGNED exactInputSingle swap.
     *
     * The fee tier comes from the live quote rather than a default, so the prepared
     * transaction routes through the same pool that produced the price.
     */
    async prepareUnsignedTx(
      { tokenIn, tokenOut, amountIn, recipient, slippageBps = 50, fee },
      opts = {},
    ) {
      const router = venueOf(opts.scanner, "router");
      if (!router) {
        throw new Error(
          `chain ${chainId} has no verified V3 router; preparing a swap stays fail-closed. ` +
            "Add a venue with recorded provenance first (see docs/adding-a-chain.md).",
        );
      }
      if (!ADDRESS_RE.test(recipient || "")) {
        throw new Error("prepareUnsignedTx requires a valid recipient address");
      }

      const q = await this.quote({ tokenIn, tokenOut, amountIn }, opts);
      if (q.evidence !== EVIDENCE.LIVE) {
        throw new Error(
          `cannot prepare without a live quote (${q.evidence}: ${q.reason ?? "no reason given"})`,
        );
      }

      const useFee = fee ?? q.fee;
      const minOut = applySlippage(q.amountOut, slippageBps);
      if (minOut <= 0n) throw new Error("computed minOut is zero -- refusing to prepare");

      const data =
        `0x${SEL.exactInputSingle}` +
        addrWord(tokenIn) +
        addrWord(tokenOut) +
        word(useFee) +
        addrWord(recipient) +
        word(amountIn) +
        word(minOut) +
        word(0); // sqrtPriceLimitX96

      return {
        unsigned: true,
        signedBy: "user-wallet",
        chainId,
        venue: "uniswap-v3",
        tx: { to: router, data, value: "0x0" },
        guard: {
          quotedOut: q.amountOut,
          minOut: minOut.toString(),
          slippageBps,
          maxSlippageBps: MAX_SLIPPAGE_BPS,
          fee: useFee,
        },
        requires: [
          { step: "approve", token: tokenIn, spender: router, amount: String(amountIn) },
        ],
        note:
          "UNSIGNED. Re-verify the guard against a fresh quote immediately before " +
          "signing -- a quote-time minimum is not a minimum at broadcast time.",
      };
    },
  };
}
