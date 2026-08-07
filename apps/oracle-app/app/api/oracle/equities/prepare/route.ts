import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Equities product — prepare unsigned RH Uniswap artifact only.
 * Never signs. never broadcasts. Wallet must sign outside this app.
 */
export async function POST(request: NextRequest) {
  let body: { ticker?: string; recipient?: string; sizeUsd?: number | string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      {
        product: "equities",
        configured: true,
        reachable: true,
        error: "json body required",
        prepared: null,
        requiresWalletSignature: true as const,
        backendSigner: false as const,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ticker = String(body.ticker || "").trim().toUpperCase();
  const recipient = String(body.recipient || "").trim();
  const sizeUsd = body.sizeUsd == null || body.sizeUsd === "" ? 1000 : Number(body.sizeUsd);

  if (!ticker) {
    return NextResponse.json(
      {
        product: "equities",
        configured: true,
        reachable: true,
        error: "ticker required",
        prepared: null,
        requiresWalletSignature: true as const,
        backendSigner: false as const,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    return NextResponse.json(
      {
        product: "equities",
        configured: true,
        reachable: true,
        error: "recipient must be a real 0x EVM address (your wallet)",
        prepared: null,
        requiresWalletSignature: true as const,
        backendSigner: false as const,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    return NextResponse.json(
      {
        product: "equities",
        configured: true,
        reachable: true,
        error: "sizeUsd must be a positive number",
        prepared: null,
        requiresWalletSignature: true as const,
        backendSigner: false as const,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const { prepareEquityRoute, toJsonSafe } = await import("@oracle-agent/oracle/equities");
    const prepared = prepareEquityRoute({ ticker, recipient, sizeUsd });
    return NextResponse.json(
      {
        product: "equities",
        configured: true,
        reachable: true,
        error: null,
        prepared: toJsonSafe(prepared),
        requiresWalletSignature: true as const,
        backendSigner: false as const,
        generatedAt: new Date().toISOString(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "equities prepare unavailable";
    return NextResponse.json(
      {
        product: "equities",
        configured: true,
        reachable: true,
        error: message,
        prepared: null,
        requiresWalletSignature: true as const,
        backendSigner: false as const,
        generatedAt: new Date().toISOString(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
