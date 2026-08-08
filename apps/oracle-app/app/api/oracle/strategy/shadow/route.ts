import { NextRequest } from "next/server";
import { strategyPost, strategyShadowList } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return strategyShadowList();
}

export function POST(request: NextRequest) {
  return strategyPost(request, "shadow");
}
