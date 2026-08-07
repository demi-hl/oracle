import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Equities product — venue inventory.
 * Thin delegate to @oracle-agent/oracle/equities. App never reimplements ranking.
 */
export async function GET() {
  try {
    const { equityVenues, toJsonSafe } = await import("@oracle-agent/oracle/equities");
    const snap = toJsonSafe(equityVenues());
    const venues = Array.isArray(snap?.inventory)
      ? snap.inventory.map((row: { venue?: string; tier?: string; chain?: string | number; n?: number }) => ({
          id: row.venue,
          name: row.venue,
          chain: row.chain == null ? undefined : String(row.chain),
          capabilityTier: row.tier,
          canPrepare: row.tier === "prepare",
          listings: row.n ?? 0,
        }))
      : [];
    return NextResponse.json(
      {
        product: "equities",
        posture: "prepare-only discovery; only rh_uniswap can emit unsigned tx",
        requiresWalletSignature: true,
        backendSigner: false,
        venues,
        snapshot: snap,
        generatedAt: new Date().toISOString(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "equities venues unavailable";
    return NextResponse.json(
      {
        product: "equities",
        posture: "prepare-only discovery; only rh_uniswap can emit unsigned tx",
        requiresWalletSignature: true,
        backendSigner: false,
        venues: [],
        error: message,
        generatedAt: new Date().toISOString(),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
