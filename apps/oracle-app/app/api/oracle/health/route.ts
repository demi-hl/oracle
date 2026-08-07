import { NextResponse } from "next/server";
import { getOracleHealth } from "@/lib/oracle/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getOracleHealth();
  return NextResponse.json(health, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
