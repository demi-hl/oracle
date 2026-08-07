import { NextResponse } from "next/server";
import { getHolderStatus } from "@/lib/oracle/holder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getHolderStatus();
  return NextResponse.json(status, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
