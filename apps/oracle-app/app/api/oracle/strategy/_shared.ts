import { NextRequest, NextResponse } from "next/server";

type StrategyOperation = "draft" | "validate" | "backtest" | "optimize" | "evidence" | "shadow" | "prepare";

export async function strategyPost(request: NextRequest, operation: StrategyOperation) {
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON object required");
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON object required";
    return NextResponse.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const { runStrategyOperation } = await import("@oracle-agent/oracle/strategy");
    const result = await runStrategyOperation(operation, {
      ...body,
      nowMs: typeof body.nowMs === "number" ? body.nowMs : Date.now(),
    });
    return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "strategy request rejected";
    return NextResponse.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}

export async function strategyShadowList() {
  try {
    const { runStrategyOperation } = await import("@oracle-agent/oracle/strategy");
    const result = await runStrategyOperation("shadow", { action: "list", nowMs: Date.now() });
    return NextResponse.json(result, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "strategy shadow unavailable";
    return NextResponse.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
