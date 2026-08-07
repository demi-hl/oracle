import { NextResponse } from "next/server";
import { getOracleCatalog } from "@/lib/oracle/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const catalog = await getOracleCatalog();
  return NextResponse.json(catalog, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
