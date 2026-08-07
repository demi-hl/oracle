import { NextRequest, NextResponse } from "next/server";
import {
  ORACLE_SIGNER_CONTRACT,
  ORACLE_SWAP_PREPARE_CHAINS,
  type OracleSwapPrepareResponse,
} from "@oracle-agent/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Swap PREPARE. Asks the local Oracle desk for a quote and an unsigned intent.
 * This route never signs, submits, broadcasts, holds key material, or takes
 * custody. A wallet must independently review and sign any later transaction.
 *
 * There is deliberately NO default desk URL. Port 8799 hosts the shipped
 * oracle-public server, whose route table has no POST /swap/prepare, so
 * defaulting to it made every quote request 404 while the UI presented a
 * working prepare surface. An unset desk is reported as unconfigured instead.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SYMBOL_LEN = 24;

function deskBaseUrl(): string | null {
  const raw = (process.env.ORACLE_DESK_URL ?? "").trim();
  if (raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // Loopback only, matching the signer bridge. The UI frames this prepare path
  // as local ("ORACLE PREPARES. THE SIGNER HOLDS THE KEY."), and an off-box desk
  // would quietly ship every quote request — wallet address, chain, size — to a
  // remote host while the interface still claimed a local topology.
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
  return parsed.origin;
}

function unavailable(reason: string): OracleSwapPrepareResponse {
  return {
    configured: false,
    reachable: false,
    error: reason,
    quote: null,
    requiresWalletSignature: true,
    backendSigner: false,
  };
}

function cleanSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  if (trimmed === "" || trimmed.length > MAX_SYMBOL_LEN) return null;
  if (!/^[A-Z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

function cleanAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(t) ? t : null;
}

function cleanAmount(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  if (Number(text) <= 0) return null;
  return text;
}

export async function POST(request: NextRequest) {
  const base = deskBaseUrl();
  if (base === null) {
    return NextResponse.json(
      unavailable("Oracle desk is not configured. Set ORACLE_DESK_URL to a loopback desk that implements POST /swap/prepare."),
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(unavailable("Request body must be JSON"), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const chainId = typeof body.chainId === "string" ? body.chainId : null;
  const chain = ORACLE_SWAP_PREPARE_CHAINS.find((c) => c.id === chainId);
  const sellSymbol = cleanSymbol(body.sellSymbol);
  const buySymbol = cleanSymbol(body.buySymbol);
  const sellAmount = cleanAmount(body.sellAmount);
  const taker = cleanAddress(body.taker);

  if (!chain) {
    return NextResponse.json(unavailable("Unknown or unsupported chain"), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!sellSymbol || !buySymbol || !sellAmount) {
    return NextResponse.json(
      unavailable("Sell symbol, buy symbol, and a positive amount are required"),
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!taker) {
    // A prepared transaction is built FOR an address. Without one the desk
    // cannot produce calldata, and quoting into a placeholder would hand back
    // a transaction nobody can sign.
    return NextResponse.json(
      unavailable("Connect a wallet: a prepared swap is built for the address that will sign it"),
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (sellSymbol === buySymbol) {
    return NextResponse.json(unavailable("Sell and buy assets must differ"), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const res = await fetch(base + ORACLE_SIGNER_CONTRACT.routes.prepareSwap.upstreamPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        chain: chain.id,
        chainId: chain.chainId,
        sellSymbol,
        buySymbol,
        sellAmount,
        taker,
      }),
    });

    if (!res.ok) {
      return NextResponse.json(
        { ...unavailable("Oracle desk responded " + res.status), configured: true },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    const payload = (await res.json()) as Record<string, unknown>;

    // The desk answers a failed routing attempt with ok:false plus a specific,
    // actionable reason ("approve the spender first", "price impact guard
    // rejected the venue"). Flattening every one of those into "no executable
    // quote" threw away the only part the user can act on.
    if (payload.ok === false) {
      const reason =
        typeof payload.reason === "string" && payload.reason.trim() !== ""
          ? payload.reason.trim()
          : "Oracle desk returned no executable quote";
      return NextResponse.json(
        { ...unavailable(reason), configured: true, reachable: true },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    const q = (payload.quote ?? payload) as Record<string, unknown>;

    const numberOrNull = (v: unknown): number | null => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const stringOrNull = (v: unknown): string | null =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : null;

    const buyAmount = stringOrNull(q.buyAmount ?? q.amountOut);
    if (buyAmount === null) {
      return NextResponse.json(
        {
          ...unavailable("Oracle desk returned no executable quote"),
          configured: true,
          reachable: true,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      {
        configured: true,
        reachable: true,
        error: null,
        requiresWalletSignature: true,
        backendSigner: false,
        quote: {
          sellSymbol,
          buySymbol,
          sellAmount,
          buyAmount,
          buyAmountFormatted: stringOrNull(q.buyAmountFormatted),
          rate: stringOrNull(q.rate),
          routeLabel: stringOrNull(q.routeLabel ?? q.source),
          priceImpactPct: numberOrNull(q.priceImpactPct ?? q.priceImpact),
          // A slippage cap the desk did not send is not 0.50%; it is unknown.
          // Defaulting here printed an invented protection level in the UI as
          // if the route had quoted it, which is the one number a user reads to
          // decide how much they can lose. Pass the absence through.
          slippageBps: numberOrNull(q.slippageBps),
          expiresAt: stringOrNull(q.expiresAt),
          intentHash: stringOrNull(q.intentHash ?? q.prepareHash),
        },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "Oracle swap quote timed out"
        : "Oracle desk is unavailable";
    return NextResponse.json(
      { ...unavailable(reason), configured: true },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
