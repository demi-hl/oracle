// Swap PREPARE for the desk plane.
//
// The app called POST /swap/prepare and nothing implemented it, so the UI
// presented a working prepare surface that could never return a quote. This is
// the missing handler.
//
// It is a THIN ADAPTER over the same prepareBestRoute() the CLI drives via
// `oracle route prepare` -- not a second implementation. The app speaks
// symbols and human decimal amounts ("0.5 USDC"); the router speaks addresses
// and raw integer units. Everything here is that translation plus the custody
// invariants, and the actual routing/comparison/preparation is the shared path.
//
// Custody: returns an UNSIGNED transaction. Never signs, never broadcasts,
// never touches key material. The wallet is the only thing that can authorize.

import { prepareBestRoute } from "../router/prepare-route.mjs";
import { getScanner, listScanners } from "../scanner/contract.mjs";
import { registerBuiltinScanners } from "../scanner/chains.config.mjs";
import { UNI_V3_CHAINS } from "../data/providers/uniswap-v3.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_SYMBOL_LEN = 24;

let scannersReady = false;
function ensureScanners() {
  if (scannersReady) return;
  registerBuiltinScanners();
  scannersReady = true;
}

export class SwapPrepareError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Accept a numeric chain id or a scanner key ("base", "ethereum"). */
export function resolveChainId(ref) {
  ensureScanners();
  if (ref == null || ref === "") throw new SwapPrepareError(400, "chainId is required");
  const n = Number(ref);
  if (Number.isFinite(n) && getScanner(n)) return n;
  const s = listScanners().find((x) => x.key === String(ref).toLowerCase());
  if (s) return s.chainId;
  throw new SwapPrepareError(400, `unknown chain "${ref}"`);
}

function cleanSymbol(value, label) {
  if (typeof value !== "string") throw new SwapPrepareError(400, `${label} is required`);
  const t = value.trim();
  if (t === "" || t.length > MAX_SYMBOL_LEN) throw new SwapPrepareError(400, `${label} is invalid`);
  // Symbols and 0x addresses both ride this field; the scanner resolves either.
  if (!/^[A-Za-z0-9._-]+$/.test(t) && !ADDRESS_RE.test(t)) {
    throw new SwapPrepareError(400, `${label} is invalid`);
  }
  return t;
}

/**
 * Human decimal amount -> raw integer units, without floating point.
 *
 * Number(0.1) * 1e18 is 100000000000000001... and a wrong amountIn silently
 * prepares a transaction for the wrong size, so this is done on strings.
 */
export function toRawUnits(amount, decimals) {
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new SwapPrepareError(400, "sellAmount must be a positive decimal number");
  if (Number(text) <= 0) throw new SwapPrepareError(400, "sellAmount must be greater than zero");
  const d = Number.isFinite(Number(decimals)) ? Number(decimals) : 18;
  const [whole, frac = ""] = text.split(".");
  if (frac.length > d) {
    throw new SwapPrepareError(400, `sellAmount has more precision than the token's ${d} decimals`);
  }
  const padded = frac.padEnd(d, "0");
  const raw = (BigInt(whole) * 10n ** BigInt(d) + BigInt(padded || "0")).toString();
  if (raw === "0") throw new SwapPrepareError(400, "sellAmount rounds to zero at this token's precision");
  return raw;
}

/**
 * Symbol or address -> { address, decimals }.
 *
 * scanner.resolveToken() deliberately refuses symbols ("symbol lookup is a
 * market-data concern") and only reads on-chain metadata for a 20-byte
 * address. So a bare symbol is mapped through the per-chain token constants
 * the V3 provider already maintains, and anything that is already an address
 * goes straight to the scanner for its REAL on-chain decimals.
 */
async function resolveAsset(chainId, ref) {
  ensureScanners();
  if (ADDRESS_RE.test(ref)) {
    const scanner = getScanner(chainId);
    const meta = await scanner.resolveToken(ref).catch(() => null);
    const decimals = Number(meta?.decimals);
    return { address: ref, decimals: Number.isFinite(decimals) ? decimals : null };
  }
  const cfg = UNI_V3_CHAINS[chainId];
  if (!cfg) return null;
  const key = ref.toLowerCase();
  // USDC is 6 decimals nearly everywhere and WETH is 18; both are confirmed
  // against the chain below rather than trusted from this table.
  const address = key === "usdc" ? cfg.usdc : key === "weth" || key === "eth" ? cfg.weth : null;
  if (!address) return null;
  const scanner = getScanner(chainId);
  const meta = await scanner.resolveToken(address).catch(() => null);
  const decimals = Number(meta?.decimals);
  return { address, decimals: Number.isFinite(decimals) ? decimals : null };
}

/**
 * @param {object} body  { chainId, sellSymbol, buySymbol, sellAmount, taker, source? }
 * @returns unsigned prepare artifact in the shape the app's parser reads
 */
export async function prepareSwapForDesk(body = {}, opts = {}) {
  const chainId = resolveChainId(body.chainId ?? body.chain);
  const sellSymbol = cleanSymbol(body.sellSymbol ?? body.sellToken, "sellSymbol");
  const buySymbol = cleanSymbol(body.buySymbol ?? body.buyToken, "buySymbol");
  if (sellSymbol.toLowerCase() === buySymbol.toLowerCase()) {
    throw new SwapPrepareError(400, "sell and buy assets must differ");
  }

  // prepareBestRoute refuses placeholder/burn takers itself; surface that as a
  // 400 rather than letting it throw as an unhandled 500.
  const taker = typeof body.taker === "string" ? body.taker.trim() : "";
  if (!ADDRESS_RE.test(taker)) {
    throw new SwapPrepareError(400, "taker must be the wallet address that will sign");
  }

  const [inTok, outTok] = await Promise.all([
    resolveAsset(chainId, sellSymbol),
    resolveAsset(chainId, buySymbol),
  ]);
  if (!inTok) throw new SwapPrepareError(400, `could not resolve sell asset "${sellSymbol}" on chain ${chainId}`);
  if (!outTok) throw new SwapPrepareError(400, `could not resolve buy asset "${buySymbol}" on chain ${chainId}`);

  const amountIn = toRawUnits(body.sellAmount, inTok.decimals);

  const r = await prepareBestRoute(
    {
      chainId,
      tokenIn: inTok.address || sellSymbol,
      tokenOut: outTok.address || buySymbol,
      amountIn,
      taker,
      decimalsIn: inTok.decimals ?? null,
      decimalsOut: outTok.decimals ?? null,
      source: typeof body.source === "string" && body.source.trim() !== "" ? body.source.trim() : undefined,
    },
    opts,
  );

  if (!r.ok) {
    // A liquidity/impact rejection is a real answer, not a server fault.
    return {
      ok: false,
      reason: r.reason,
      priceImpactBlocked: Boolean(r.priceImpactBlocked),
      requiresWalletSignature: true,
      backendSigner: false,
    };
  }

  const dOut = outTok.decimals ?? 18;
  const buyAmountRaw = r.minOut ?? r.chosen?.netOut ?? r.chosen?.grossOut ?? null;

  return {
    ok: true,
    requiresWalletSignature: true,
    backendSigner: false,
    quote: {
      sellSymbol,
      buySymbol,
      sellAmount: String(body.sellAmount),
      // Raw units stay authoritative; the formatted value is for display only.
      // Emitting only the formatted string is what broke portfolio pricing.
      buyAmount: buyAmountRaw == null ? null : String(buyAmountRaw),
      buyAmountFormatted:
        buyAmountRaw == null ? null : (Number(buyAmountRaw) / 10 ** dOut).toString(),
      routeLabel: r.chosen?.source ?? null,
      priceImpactPct: Number.isFinite(Number(r.chosen?.priceImpactPct))
        ? Number(r.chosen.priceImpactPct)
        : null,
      // Absent is unknown, not zero. Inventing a slippage cap prints a
      // protection level the route never quoted.
      slippageBps: Number.isFinite(Number(r.slippageBps)) ? Number(r.slippageBps) : null,
      intentHash: r.intentHash ?? null,
      minOut: r.minOut ?? null,
      requiresApproval: r.requiresApproval ?? null,
      warnings: Array.isArray(r.warnings) ? r.warnings : [],
    },
    transaction: r.transaction ?? null,
  };
}
