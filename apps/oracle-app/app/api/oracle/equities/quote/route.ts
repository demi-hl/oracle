import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Equities product — ranked best-ex quote.
 * Shared logic lives in @oracle-agent/oracle/equities (same as CLI/MCP).
 */
export async function GET(request: NextRequest) {
  const ticker = (request.nextUrl.searchParams.get("ticker") || "").trim().toUpperCase();
  const sizeRaw = request.nextUrl.searchParams.get("size") || request.nextUrl.searchParams.get("sizeUsd") || "1000";
  const sizeUsd = Number(sizeRaw);
  const horizonRaw = request.nextUrl.searchParams.get("horizonHours");
  const horizonHours = horizonRaw == null || horizonRaw === "" ? undefined : Number(horizonRaw);

  if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,15}$/.test(ticker)) {
    return NextResponse.json(
      {
        product: "equities",
        error: "ticker required (e.g. NVDA, SPY, TSLA)",
        requiresWalletSignature: true,
        backendSigner: false,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    return NextResponse.json(
      {
        product: "equities",
        error: "size must be a positive number (USD notional)",
        requiresWalletSignature: true,
        backendSigner: false,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const { bestEquityRoute, toJsonSafe } = await import("@oracle-agent/oracle/equities");
    const result = bestEquityRoute({
      ticker,
      sizeUsd,
      ...(Number.isFinite(horizonHours) ? { horizonHours } : {}),
    });
    return NextResponse.json(
      {
        product: "equities",
        posture: "prepare-only discovery; only rh_uniswap can emit unsigned tx",
        requiresWalletSignature: true,
        backendSigner: false,
        quote: toJsonSafe(result),
        generatedAt: new Date().toISOString(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "equities quote unavailable";
    return NextResponse.json(
      {
        product: "equities",
        posture: "prepare-only discovery; only rh_uniswap can emit unsigned tx",
        requiresWalletSignature: true,
        backendSigner: false,
        quote: null,
        error: message,
        generatedAt: new Date().toISOString(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
