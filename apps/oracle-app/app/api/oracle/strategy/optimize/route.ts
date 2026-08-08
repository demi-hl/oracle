import { NextRequest } from "next/server";
import { strategyPost } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return strategyPost(request, "optimize");
}
