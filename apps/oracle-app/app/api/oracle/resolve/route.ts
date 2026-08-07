import { NextRequest, NextResponse } from "next/server";
// @ts-ignore -- ESM .mjs provider without bundled type declarations
import { lookupName, resolveName, ADDRESS_RE } from "@oracle-agent/oracle/names";

export const dynamic = "force-dynamic";

/**
 * Cross-chain name resolution for the wallet book.
 *
 * Read-only: the underlying module calls rpcCall(), whose allowlist refuses any
 * non-read RPC method, so this route cannot sign or broadcast. It exists so the
 * browser can resolve .hl/.hype/.eth without shipping an RPC client, and so the
 * app and CLI share one resolution chain instead of drifting apart.
 *
 * Accepts either direction:
 *   ?q=demi.hl   -> { address, source }
 *   ?q=0x4d47..  -> { name, source }
 */
export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get("q") || "").trim();
  if (!q) {
    return NextResponse.json({ error: "q is required" }, { status: 400 });
  }
  if (q.length > 128) {
    return NextResponse.json({ error: "q is too long" }, { status: 400 });
  }

  try {
    if (ADDRESS_RE.test(q)) {
      const hit = await lookupName(q);
      return NextResponse.json({
        input: q,
        address: q,
        name: hit?.name ?? null,
        source: hit?.source ?? null,
      });
    }

    const hit = await resolveName(q);
    if (!hit) {
      // A name that does not resolve is a normal answer, not a failure: the
      // caller needs to tell "no such name" apart from "lookup broke".
      return NextResponse.json({ input: q, address: null, name: q, source: null });
    }
    return NextResponse.json({ input: q, address: hit.address, name: hit.name, source: hit.source });
  } catch {
    return NextResponse.json({ error: "resolution unavailable" }, { status: 503 });
  }
}
