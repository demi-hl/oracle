// Venue-backed capabilities: quote, sellSimulation, prepareUnsignedTx.
//
// These are the three capabilities the generic scanner cannot provide, because each
// one needs a VERIFIED router address for the specific chain. That is not a gap to
// paper over -- it is the reason the destination allowlist exists.
//
// Scope: Uniswap-V2-style routers (getAmountsOut / swapExactTokensForTokens), which
// covers the large majority of forks across EVM chains. A V3/V4 or custom-quoter
// venue needs its own adapter; see the notes at the bottom.
//
// Custody: prepareUnsignedTx returns an UNSIGNED transaction object. Nothing here
// holds a key, signs, or broadcasts. The user's wallet does that.

import { rpcCall } from "../data/providers/evm-rpc.mjs";
import { EVIDENCE, RISK } from "./contract.mjs";

// --- ABI encode/decode, kept dependency-free ---------------------------------

const SEL = {
  // getAmountsOut(uint256,address[])
  getAmountsOut: "d06ca61f",
  // swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
  swapExactTokensForTokens: "38ed1739",
  // swapExactETHForTokens(uint256,address[],address,uint256)
  swapExactETHForTokens: "7ff36ab5",
};

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, "0");

function encodeAmountsOut(amountIn, path) {
  return (
    `0x${SEL.getAmountsOut}` +
    word(amountIn) +
    word(64) + // offset to the array
    word(path.length) +
    path.map(addrWord).join("")
  );
}

/** Decode a `uint256[]` return. */
function decodeUintArray(hex) {
  if (!hex || hex === "0x") return null;
  const b = hex.slice(2);
  if (b.length < 128) return null;
  const n = Number(BigInt(`0x${b.slice(64, 128)}`));
  if (!Number.isFinite(n) || n < 1 || n > 16) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = 128 + i * 64;
    if (b.length < start + 64) return null;
    out.push(BigInt(`0x${b.slice(start, start + 64)}`));
  }
  return out;
}

function routerOf(scanner, kind = "router") {
  const v = (scanner?.venues || []).find((x) => x.kind === kind);
  return v?.address ?? null;
}

/**
 * Apply a slippage guard to get minOut.
 *
 * The supplied tolerance is a MAXIMUM, not the value to use, and it is capped hard.
 * A guard that yields under pressure is decoration -- if a route needs more than the
 * cap, the correct answer is to block and requote, not to widen.
 */
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

// --- capability implementations ----------------------------------------------

/**
 * Build the venue-backed capabilities for a chain that has a verified V2 router.
 *
 * @param {object} cfg
 * @param {number} cfg.chainId
 * @param {string} [cfg.wrappedNative] needed to route native<->token
 */
export function v2VenueCapabilities(cfg) {
  const { chainId, wrappedNative } = cfg;

  async function amountsOut(router, amountIn, path, opts) {
    const res = await rpcCall(
      chainId,
      "eth_call",
      [{ to: router, data: encodeAmountsOut(amountIn, path) }, "latest"],
      opts,
    );
    return decodeUintArray(res?.result ?? res);
  }

  return {
    /**
     * Price an exact-input route. Read-only; touches no state.
     */
    async quote({ tokenIn, tokenOut, amountIn, path }, opts = {}) {
      const router = routerOf(opts.scanner);
      if (!router) {
        return {
          chainId,
          evidence: EVIDENCE.UNAVAILABLE,
          reason:
            "no verified router configured for this chain; quoting stays fail-closed " +
            "rather than guessing a venue address",
        };
      }
      const route = path || [tokenIn, tokenOut];
      if (route.some((a) => !/^0x[0-9a-fA-F]{40}$/.test(a || ""))) {
        throw new Error("quote requires valid 20-byte addresses");
      }

      const amounts = await amountsOut(router, amountIn, route, opts);
      if (!amounts) {
        return {
          chainId,
          router,
          path: route,
          evidence: EVIDENCE.UNKNOWN,
          reason: "router returned no amounts -- no pool for this path, or the call reverted",
        };
      }

      return {
        chainId,
        router,
        path: route,
        amountIn: String(amountIn),
        amountOut: amounts[amounts.length - 1].toString(),
        hops: route.length - 1,
        evidence: EVIDENCE.LIVE,
        // The price a quote reports is pre-slippage and pre-gas. Saying so prevents
        // it being read as an expected fill.
        note: "exact-input quote at current reserves; not a guaranteed fill",
      };
    },

    /**
     * Round-trip check: buy the token, then sell it back.
     *
     * This is the single most valuable check on a low-cap venue. Most losses are not
     * bad entries -- they are tokens that buy cleanly and cannot be sold. A
     * successful BUY quote proves nothing about the sell side.
     *
     * State-free: both legs are eth_call quotes, so nothing is spent to learn this.
     */
    async sellSimulation({ token, amountIn, base }, opts = {}) {
      const router = routerOf(opts.scanner);
      const quoteBase = base || wrappedNative;

      // Same self-pair trap as the V3 adapter: [WETH, WETH] is not a route, so
      // the probe would report FAIL on the chain's most liquid asset. UNKNOWN is
      // the honest answer -- a false FAIL reads as "honeypot".
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

      if (!router || !quoteBase) {
        return {
          chainId,
          token,
          verdict: RISK.UNKNOWN,
          evidence: EVIDENCE.UNAVAILABLE,
          reason: router
            ? "no wrappedNative configured for this chain, so no base asset to round-trip against"
            : "no verified router configured for this chain",
        };
      }

      const buy = await amountsOut(router, amountIn, [quoteBase, token], opts);
      if (!buy) {
        return {
          chainId,
          token,
          verdict: RISK.FAIL,
          evidence: EVIDENCE.LIVE,
          leg: "buy",
          reason: "buy leg returned no amounts -- no route in",
        };
      }
      const bought = buy[buy.length - 1];
      if (bought === 0n) {
        return {
          chainId,
          token,
          verdict: RISK.FAIL,
          evidence: EVIDENCE.LIVE,
          leg: "buy",
          reason: "buy leg quotes zero output",
        };
      }

      const sell = await amountsOut(router, bought, [token, quoteBase], opts);
      if (!sell) {
        // The honeypot signature: in works, out does not.
        return {
          chainId,
          token,
          verdict: RISK.FAIL,
          evidence: EVIDENCE.LIVE,
          leg: "sell",
          bought: bought.toString(),
          reason:
            "SELL LEG FAILED while the buy leg quoted fine. This is the honeypot " +
            "signature: do not trade.",
        };
      }

      const returned = sell[sell.length - 1];
      // Retention in bps of the original input. A clean V2 round trip loses roughly
      // 2x the pool fee plus impact, so ~9940 bps on a deep pool at small size.
      const retentionBps = Number((returned * 10_000n) / BigInt(amountIn));

      // Thresholds are deliberately loose: this separates "taxed or illiquid" from
      // "normal", not "good trade" from "bad trade".
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
        token,
        base: quoteBase,
        router,
        verdict,
        reason,
        amountIn: String(amountIn),
        bought: bought.toString(),
        returned: returned.toString(),
        retentionBps,
        evidence: EVIDENCE.LIVE,
        note: "Quote-level round trip. It does not prove transfer hooks absent at execution time.",
      };
    },

    /**
     * Build an UNSIGNED swap transaction.
     *
     * Returns a plain transaction object for the caller's wallet to sign. There is no
     * signing path in this module by construction.
     */
    async prepareUnsignedTx(
      { tokenIn, tokenOut, amountIn, recipient, slippageBps = 50, deadlineSeconds = 900, path },
      opts = {},
    ) {
      const scanner = opts.scanner;
      const router = routerOf(scanner);
      if (!router) {
        throw new Error(
          `chain ${chainId} has no verified router; preparing a swap stays fail-closed. ` +
            "Add a venue with recorded provenance first (see docs/adding-a-chain.md).",
        );
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient || "")) {
        throw new Error("prepareUnsignedTx requires a valid recipient address");
      }

      const route = path || [tokenIn, tokenOut];
      const q = await this.quote({ tokenIn, tokenOut, amountIn, path: route }, opts);
      if (q.evidence !== EVIDENCE.LIVE) {
        throw new Error(
          `cannot prepare without a live quote (${q.evidence}: ${q.reason ?? "no reason given"})`,
        );
      }

      // Guard computed from the live quote, not from a stale number.
      const minOut = applySlippage(q.amountOut, slippageBps);
      if (minOut <= 0n) throw new Error("computed minOut is zero -- refusing to prepare");

      const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(deadlineSeconds));
      const isNativeIn =
        wrappedNative && route[0].toLowerCase() === wrappedNative.toLowerCase() && opts.useNative;

      const data = isNativeIn
        ? `0x${SEL.swapExactETHForTokens}` +
          word(minOut) +
          word(128) +
          addrWord(recipient) +
          word(deadline) +
          word(route.length) +
          route.map(addrWord).join("")
        : `0x${SEL.swapExactTokensForTokens}` +
          word(amountIn) +
          word(minOut) +
          word(160) +
          addrWord(recipient) +
          word(deadline) +
          word(route.length) +
          route.map(addrWord).join("");

      return {
        unsigned: true,
        signedBy: "user-wallet",
        chainId,
        tx: {
          to: router,
          data,
          value: isNativeIn ? `0x${BigInt(amountIn).toString(16)}` : "0x0",
        },
        guard: {
          quotedOut: q.amountOut,
          minOut: minOut.toString(),
          slippageBps,
          maxSlippageBps: MAX_SLIPPAGE_BPS,
          deadline: deadline.toString(),
        },
        // An ERC-20 input needs an allowance first. Reporting it as a separate step
        // keeps "approved" and "swapped" from being collapsed into one claim.
        requires: isNativeIn
          ? []
          : [{ step: "approve", token: route[0], spender: router, amount: String(amountIn) }],
        note:
          "UNSIGNED. Re-verify the guard against a fresh quote immediately before " +
          "signing -- a quote-time minimum is not a minimum at broadcast time.",
      };
    },
  };
}

// A V3/V4 or custom-quoter venue does NOT fit this adapter: V3 needs a Quoter
// contract and fee tiers, and some forks require an off-chain signed quote that
// cannot be forged locally. Write a sibling adapter rather than bending this one --
// silently mis-encoding a swap is worse than declaring the capability unsupported.
