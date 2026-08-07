import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Scoring lives in @oracle-agent/oracle so the CLI (`oracle farm discover`),
// this route, and any MCP harness rank pools with one implementation. It used
// to be duplicated inline here, which meant the CLI had no farming surface at
// all and any tuning silently applied to only one of them.
// @ts-ignore -- ESM .mjs provider without bundled type declarations
import { discoverFarms } from "@oracle-agent/oracle/farming";

export async function GET(request: NextRequest) {
  const chain = request.nextUrl.searchParams.get("chain");
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 12);
  const result = await discoverFarms({ chain, limit });
  return NextResponse.json(result, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
