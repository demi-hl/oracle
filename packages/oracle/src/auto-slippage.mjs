// Chain-agnostic bounded automatic slippage policy.
// Slippage protects fresh quote -> inclusion movement only. Protocol fee and
// modeled price impact already live in quoteAmountOut and must not be counted a
// second time. Every executable swap route hard-stops at 100 bps.
//
// AUTHENTICATION: the guard is HMAC-signed with the same attestation secret the
// route/vault/gmx attestations use. Quotes may attach an unsigned bound when no
// secret is configured (read/prepare UX). Sign and broadcast ALWAYS require a
// verified signature (requireSigned / enforceTxPolicy) — an unsigned guard is
// self-attested and must never authorize a swap.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { resolveAttestationSecret } from "./attestation-secret.mjs";
import { assertFreshWindow } from "./fresh-window.mjs";

export const AUTO_SLIPPAGE_MAX_BPS = 100;
export const AUTO_SLIPPAGE_DEFAULT_TTL_MS = 20_000;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function slippageSecret(secret, { required = false } = {}) {
  try {
    return resolveAttestationSecret(secret, "ORACLE_ROUTE_ATTESTATION_SECRET", "MAD_ROUTE_ATTESTATION_SECRET");
  } catch (error) {
    if (required) throw error;
    return null;
  }
}

function unsigned(guard) {
  const { signature: _sig, ...rest } = guard;
  return rest;
}

/** Sign a guard so it cannot be forged or re-attached to a different swap. */
export function signAutoSlippageGuard(guard, { secret } = {}) {
  const key = slippageSecret(secret);
  if (!key) return guard;
  return { ...guard, signature: createHmac("sha256", key).update(canonicalJson(unsigned(guard))).digest("hex") };
}

function calldataDigest(data) {
  const hex = String(data || "").toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(hex) || hex.length < 10 || hex.length % 2 !== 0) {
    throw new Error("auto-slippage calldata must be even-length hex with a selector");
  }
  return createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex");
}

export function bindAutoSlippageGuardToCall(guard, { chainId, venue, data, secret } = {}) {
  if (!guard || guard.mode !== "auto") throw new Error("bounded auto-slippage guard required");
  if (Number(guard.chainId) !== Number(chainId)) throw new Error("auto-slippage guard chain mismatch");
  if (String(guard.venue).toLowerCase() !== String(venue || "").toLowerCase()) {
    throw new Error("auto-slippage guard venue mismatch");
  }
  return signAutoSlippageGuard(
    { ...unsigned(guard), calldataHash: calldataDigest(data) },
    { secret },
  );
}

function sameSignature(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function integerCap(value) {
  const n = value == null ? AUTO_SLIPPAGE_MAX_BPS : Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("auto-slippage cap must be a non-negative integer bps value");
  }
  return Math.min(n, AUTO_SLIPPAGE_MAX_BPS);
}

export function resolveAutoSlippage({
  liquidityUsd,
  priceChange5m = 0,
  quoteAgeMs = 0,
  crossChain = false,
  requestedCapBps,
} = {}) {
  const liquidity = finite(liquidityUsd, 0);
  const depthPenalty = liquidity > 0
    ? liquidity >= 250_000
      ? 5
      : liquidity >= 100_000
        ? 10
        : liquidity >= 50_000
          ? 20
          : liquidity >= 10_000
            ? 40
            : 70
    : crossChain
      ? 30
      : 10;
  const volatilityPenalty = Math.min(60, Math.abs(finite(priceChange5m, 0)) * 2);
  const agePenalty = Math.min(40, Math.floor(Math.max(0, finite(quoteAgeMs, 0)) / 5_000) * 5);
  const requiredBps = Math.max(25, Math.ceil(20 + depthPenalty + volatilityPenalty + agePenalty));
  const capBps = integerCap(requestedCapBps);
  return {
    mode: "auto",
    requiredBps,
    selectedBps: Math.min(requiredBps, capBps),
    capBps,
    executable: requiredBps <= capBps,
  };
}

export function createAutoSlippageGuard({
  chainId,
  venue,
  quoteAmountOut,
  liquidityUsd,
  priceChange5m = 0,
  quoteAgeMs = 0,
  crossChain = false,
  requestedCapBps,
  quotedAtMs = Date.now(),
  ttlMs = AUTO_SLIPPAGE_DEFAULT_TTL_MS,
  secret,
} = {}) {
  const quote = BigInt(quoteAmountOut ?? 0);
  if (quote <= 0n) throw new Error("auto-slippage guard requires positive quoteAmountOut");
  const selected = resolveAutoSlippage({
    liquidityUsd,
    priceChange5m,
    quoteAgeMs,
    crossChain,
    requestedCapBps,
  });
  if (!selected.executable) {
    throw new Error(
      `auto-slippage requires ${selected.requiredBps} bps above hard/requested cap ${selected.capBps}; route blocked`
    );
  }
  const quoted = Number(quotedAtMs);
  if (!Number.isFinite(quoted)) {
    throw new Error("auto-slippage: quotedAtMs must be a finite number");
  }
  const ttl = Math.min(30_000, Math.max(1_000, Number(ttlMs) || AUTO_SLIPPAGE_DEFAULT_TTL_MS));
  // BigInt division truncates toward zero, so on small quotes the realised
  // floor can be far looser than the advertised cap: a 90 bps guard on a quote
  // of 3 produced minAmountOut=2, i.e. 3333 bps of actual permitted slippage.
  // Round the floor UP so the executed protection is never weaker than stated,
  // and refuse outright when the quote is too small to express the bound.
  const numerator = quote * BigInt(10_000 - selected.selectedBps);
  let minAmountOut = numerator / 10_000n;
  if (numerator % 10_000n !== 0n) minAmountOut += 1n; // ceil: favour the user
  if (minAmountOut > quote) minAmountOut = quote;
  if (quote > 0n && minAmountOut <= 0n) {
    throw new Error(
      `auto-slippage: quote ${quote} is too small to express a ${selected.selectedBps} bps floor without rounding to zero`
    );
  }
  // Verify the realised bound actually honours the cap rather than trusting the
  // arithmetic above.
  const realisedBps = Number(((quote - minAmountOut) * 10_000n) / (quote === 0n ? 1n : quote));
  if (realisedBps > selected.capBps) {
    throw new Error(
      `auto-slippage: realised floor implies ${realisedBps} bps, above cap ${selected.capBps} — refusing to issue a guard weaker than advertised`
    );
  }
  // Sign on issue so the guard is verifiable later. A secret is mandatory —
  // unsigned guards are self-attested and rejected at assert time.
  return signAutoSlippageGuard(
    {
      mode: "auto",
      chainId: Number(chainId),
      venue: String(venue || "unknown"),
      quoteAmountOut: quote.toString(),
      minAmountOut: minAmountOut.toString(),
      requiredBps: selected.requiredBps,
      selectedBps: selected.selectedBps,
      capBps: selected.capBps,
      quotedAtMs: quoted,
      expiresAtMs: quoted + ttl,
    },
    { secret }
  );
}

/**
 * Best-effort extraction of the output floor a swap call actually encodes.
 *
 * Returns null when the selector is unknown — this binds the common router
 * shapes without pretending to be a universal ABI decoder. A null result means
 * "cannot verify from calldata", not "verified safe": the venue allowlist and
 * the guard's own bounds still apply.
 */
function encodedMinOut(data) {
  const hex = String(data || "");
  if (!/^0x[0-9a-fA-F]+$/.test(hex) || hex.length < 10 || hex.length % 2 !== 0) return null;
  const selector = hex.slice(0, 10).toLowerCase();
  const words = [];
  for (let i = 10; i + 64 <= hex.length; i += 64) words.push(hex.slice(i, i + 64));
  const word = (i) => (words[i] == null ? null : BigInt("0x" + words[i]));

  switch (selector) {
    // Uniswap V3 SwapRouter — exactInputSingle with deadline:
    //   (tokenIn,tokenOut,fee,recipient,deadline,amountIn,amountOutMinimum,
    //    sqrtPriceLimitX96) — all static, so amountOutMinimum is word 6.
    case "0x414bf389":
      return word(6);
    // SwapRouter02 — SAME name, NO deadline member:
    //   (tokenIn,tokenOut,fee,recipient,amountIn,amountOutMinimum,
    //    sqrtPriceLimitX96) — amountOutMinimum shifts to word 5.
    // Treating this as the 8-member shape reads sqrtPriceLimitX96 instead.
    case "0x04e45aaf":
      return word(5);
    // exactInput((bytes path,address recipient,uint256 deadline,
    //   uint256 amountIn,uint256 amountOutMinimum))
    //
    // The struct's FIRST member is dynamic (bytes path), so the struct itself
    // is encoded behind an offset and its members live in a tail:
    //   head[0]           = offset to the struct
    //   tail[0] (word 1)  = offset to path
    //   tail[1] (word 2)  = recipient
    //   tail[2] (word 3)  = deadline
    //   tail[3] (word 4)  = amountIn
    //   tail[4] (word 5)  = amountOutMinimum   <-- the real output floor
    //
    // Reading word 4 here checked amountIn, which an attacker simply sets to
    // the guard's expected value while leaving amountOutMinimum at 0. Follow
    // the offset instead of assuming a fixed layout.
    case "0xc04b8d59": {
      const structOffset = word(0);
      if (structOffset == null) return null;
      // Offsets are byte counts from the start of the argument block.
      const base = Number(structOffset) / 32;
      if (!Number.isInteger(base) || base < 0) return null;
      return word(base + 4);
    }
    // SwapRouter02 exactInput((bytes path,address recipient,uint256 amountIn,
    //   uint256 amountOutMinimum)) — no deadline, so the floor is tail word 3.
    case "0xb858183f": {
      const structOffset = word(0);
      if (structOffset == null) return null;
      const base = Number(structOffset) / 32;
      if (!Number.isInteger(base) || base < 0) return null;
      return word(base + 3);
    }
    // Aerodrome Slipstream exactInputSingle with tickSpacing and deadline
    case "0xa026383e":
      return word(6);
    // V2 swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline)
    case "0x38ed1739":
    case "0x5c11d795": // ...SupportingFeeOnTransferTokens
      return word(1);
    // V2 swapExactETHForTokens(amountOutMin, path, to, deadline)
    case "0x7ff36ab5":
    case "0xb6f9de95":
      return word(0);
    // V2 swapExactTokensForETH(amountIn, amountOutMin, path, to, deadline)
    case "0x18cbafe5":
    case "0x791ac947":
      return word(1);
    default:
      return null;
  }
}


export function assertAutoSlippageGuard(
  guard,
  { nowMs = Date.now(), chainId, venue, secret, tx, requireSigned = false } = {},
) {
  if (!guard || guard.mode !== "auto") {
    throw new Error("bounded auto-slippage guard required");
  }

  // Verify authenticity FIRST when signing/broadcasting. Quotes may attach an
  // unsigned bound for display; the policy gate always passes requireSigned=true.
  const key = slippageSecret(secret, { required: requireSigned });
  if (requireSigned && !key) {
    throw new Error("auto-slippage attestation secret required for signing or broadcast");
  }
  if (key) {
    const expected = createHmac("sha256", key).update(canonicalJson(unsigned(guard))).digest("hex");
    if (!sameSignature(guard.signature, expected)) {
      throw new Error("auto-slippage guard signature mismatch — the guard was not issued by this Oracle");
    }
  } else if (guard.signature) {
    throw new Error("auto-slippage guard carries a signature but no attestation secret is configured");
  }
  const selected = Number(guard.selectedBps);
  const cap = Number(guard.capBps);
  if (!Number.isInteger(selected) || selected < 0 || selected > AUTO_SLIPPAGE_MAX_BPS) {
    throw new Error(`auto-slippage selected tolerance exceeds hard 100 bps cap`);
  }
  if (!Number.isInteger(cap) || cap < 0 || cap > AUTO_SLIPPAGE_MAX_BPS || selected > cap) {
    throw new Error(`auto-slippage cap exceeds hard 100 bps cap`);
  }
  // Fail CLOSED on an unusable clock: Number(NaN) > x is false, so a broken or
  // attacker-influenced clock made an expired quote eternal.
  try {
    assertFreshWindow({ expiresAtMs: guard.expiresAtMs, issuedAtMs: guard.quotedAtMs }, nowMs, "auto-slippage quote");
  } catch (e) {
    throw new Error(`${e.message}; re-quote before signing`);
  }
  if (chainId != null && Number(guard.chainId) !== Number(chainId)) {
    throw new Error("auto-slippage guard chain mismatch");
  }
  if (venue && String(guard.venue).toLowerCase() !== String(venue).toLowerCase()) {
    throw new Error("auto-slippage guard venue mismatch");
  }
  const quote = BigInt(guard.quoteAmountOut ?? 0);
  const minimum = BigInt(guard.minAmountOut ?? 0);
  if (quote <= 0n || minimum <= 0n) {
    throw new Error("auto-slippage guard amounts must be positive");
  }
  const protectedFloor = quote * BigInt(10_000 - selected) / 10_000n;
  if (minimum < protectedFloor) {
    throw new Error("auto-slippage guard is under-protected relative to its fresh quote");
  }
  if (tx?.data && guard.minAmountOut != null) {
    if (guard.calldataHash != null) {
      if (String(guard.calldataHash) !== calldataDigest(tx.data)) {
        throw new Error("auto-slippage guard is not bound to this call: calldata hash mismatch");
      }
    } else {
      const encoded = encodedMinOut(tx.data);
      if (encoded == null) {
        const selector = String(tx.data).slice(0, 10);
        throw new Error(
          `auto-slippage: cannot verify the output floor encoded by selector ${selector}; ` +
            "refusing rather than trusting unbound calldata at an allowlisted venue"
        );
      }
      if (encoded !== BigInt(guard.minAmountOut)) {
        throw new Error(
          `auto-slippage guard is not bound to this call: guard minAmountOut ${guard.minAmountOut} but calldata encodes ${encoded}`
        );
      }
    }
  }
  return true;
}

export function attachAutoSlippage(result, {
  chainId,
  venue,
  amountOut,
  liquidityUsd,
  priceChange5m,
  crossChain,
  requestedCapBps,
  quotedAtMs = Date.now(),
  ttlMs,
} = {}) {
  const autoSlippage = createAutoSlippageGuard({
    chainId,
    venue,
    quoteAmountOut: amountOut,
    liquidityUsd,
    priceChange5m,
    crossChain,
    requestedCapBps,
    quotedAtMs,
    ttlMs,
  });
  return { ...result, autoSlippage, amountOutMinimum: autoSlippage.minAmountOut };
}
