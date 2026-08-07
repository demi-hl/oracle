import { NextResponse } from "next/server";
import { getOracleStatus } from "@/lib/oracle/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getOracleStatus();
  return NextResponse.json(status, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
