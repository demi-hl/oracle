// Sell simulation: can you get OUT of this token before you ape in?
//
// The single most expensive failure in memecoin trading is not a bad entry, it
// is an entry you cannot exit. A honeypot lets you buy and then blocks the
// sell, or taxes it to zero, or lets only allowlisted wallets out. Every one of
// those looks identical to a healthy token on a chart and on a buy-side quote.
//
// The ONLY reliable test is to simulate the round trip: quote buy, then quote
// the sell of what that buy would give you, and compare what comes back. This
// module turns that into a verdict.
//
// It is deliberately venue-agnostic: pass in a quote function and it works on
// any chain and any DEX Oracle supports.

export const SELL_SIM = Object.freeze({
  SAFE: "SAFE",
  CAUTION: "CAUTION",
  HONEYPOT: "HONEYPOT",
  UNKNOWN: "UNKNOWN",
});

// Round-trip loss above this is a hard refusal: no honest fee structure eats
// this much, so it means a sell tax or a rigged curve.
const HONEYPOT_LOSS_BPS = 5000; // 50%
// Above this, allow the trade but make the user look at it.
const CAUTION_LOSS_BPS = 1500; // 15%

function bps(part, whole) {
  if (whole === 0n) return null;
  return Number(((whole - part) * 10000n) / whole);
}

function toBig(value, label) {
  if (value == null || value === "") throw new Error(`sell-sim: ${label} required`);
  if (typeof value === "bigint") return value;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`sell-sim: ${label} must be an integer base-unit amount`);
  return BigInt(text);
}

/**
 * Simulate the full round trip: base -> token -> base.
 *
 * @param {object} args
 * @param {string} args.token        token contract being evaluated
 * @param {string} args.base         the asset you pay with (WETH, USDC, SOL...)
 * @param {string|bigint} args.amountIn  base amount, in base units
 * @param {number} [args.chainId]
 * @param {object} opts
 * @param {(q:object)=>Promise<{outAmount:string|bigint}>} opts.quote
 *        A quote function. Called twice: buy leg, then sell leg.
 *
 * @returns verdict + the numbers behind it. NEVER a bare boolean: the caller
 *          must be able to show the user why.
 */
export async function simulateSell(args = {}, opts = {}) {
  const { token, base, chainId = null } = args;
  if (!token) throw new Error("sell-sim: token required");
  if (!base) throw new Error("sell-sim: base asset required");
  if (typeof opts.quote !== "function") throw new Error("sell-sim: opts.quote function required");

  const amountIn = toBig(args.amountIn, "amountIn");

  let buy;
  try {
    buy = await opts.quote({ chainId, inputMint: base, outputMint: token, amount: amountIn.toString(), side: "buy" });
  } catch (err) {
    return verdict(SELL_SIM.UNKNOWN, `buy leg could not be quoted: ${short(err)}`, { chainId, token, base });
  }

  const tokensOut = safeBig(buy?.outAmount);
  if (tokensOut == null || tokensOut === 0n) {
    return verdict(SELL_SIM.UNKNOWN, "buy leg returned no output — no route or no liquidity", { chainId, token, base });
  }

  let sell;
  try {
    sell = await opts.quote({ chainId, inputMint: token, outputMint: base, amount: tokensOut.toString(), side: "sell" });
  } catch (err) {
    // A buy that routes and a sell that will not is the classic honeypot shape.
    return verdict(
      SELL_SIM.HONEYPOT,
      `buy routes but the SELL leg fails to quote (${short(err)}) — you would not be able to exit`,
      { chainId, token, base, tokensOut: tokensOut.toString() }
    );
  }

  const backOut = safeBig(sell?.outAmount);
  if (backOut == null || backOut === 0n) {
    return verdict(SELL_SIM.HONEYPOT, "sell leg returns zero — the position cannot be exited for value", {
      chainId,
      token,
      base,
      tokensOut: tokensOut.toString(),
    });
  }

  const lossBps = bps(backOut, amountIn);
  const detail = {
    chainId,
    token,
    base,
    amountIn: amountIn.toString(),
    tokensOut: tokensOut.toString(),
    roundTripOut: backOut.toString(),
    roundTripLossBps: lossBps,
  };

  if (lossBps == null) return verdict(SELL_SIM.UNKNOWN, "could not compute round-trip loss", detail);
  if (lossBps >= HONEYPOT_LOSS_BPS) {
    return verdict(
      SELL_SIM.HONEYPOT,
      `round trip loses ${(lossBps / 100).toFixed(1)}% — a sell tax or rigged curve, not normal slippage`,
      detail
    );
  }
  if (lossBps >= CAUTION_LOSS_BPS) {
    return verdict(SELL_SIM.CAUTION, `round trip loses ${(lossBps / 100).toFixed(1)}% — high tax or thin liquidity`, detail);
  }
  return verdict(SELL_SIM.SAFE, `round trip loses ${(lossBps / 100).toFixed(1)}% — exit path looks normal`, detail);
}

function verdict(status, reason, detail) {
  return {
    status,
    safe: status === SELL_SIM.SAFE,
    tradable: status === SELL_SIM.SAFE || status === SELL_SIM.CAUTION,
    reason,
    ...detail,
  };
}

function safeBig(v) {
  if (v == null) return null;
  try {
    const text = String(v).trim();
    if (!/^\d+$/.test(text)) return null;
    return BigInt(text);
  } catch {
    return null;
  }
}

function short(err) {
  return String(err?.message || err).slice(0, 120);
}

/**
 * Refuse to proceed unless the token can actually be sold.
 *
 * Fails CLOSED on UNKNOWN: "we could not verify you can exit" must never read
 * as "safe to ape". Pass allowUnknown only for research surfaces where no money
 * moves.
 */
export async function assertSellable(args = {}, opts = {}) {
  const result = await simulateSell(args, opts);
  const acceptable =
    result.status === SELL_SIM.SAFE ||
    (result.status === SELL_SIM.CAUTION && opts.allowCaution !== false) ||
    (result.status === SELL_SIM.UNKNOWN && opts.allowUnknown === true);
  if (!acceptable) {
    const err = new Error(`sell-sim ${result.status}: ${result.reason}`);
    err.sellSim = result;
    throw err;
  }
  return result;
}
