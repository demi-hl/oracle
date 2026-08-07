import { NextResponse } from "next/server";
import { ORACLE_SIGNER_CONTRACT, type OracleSignerStatus } from "@oracle-agent/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only status of the LOCAL oracle-signer daemon. The signer is the only
 * component that holds key material; it binds loopback only. This route never
 * proxies a signing call, it only reports whether the daemon is up and armed so
 * the UI can tell the truth about execution posture.
 *
 * There is deliberately NO default port. Port 8787 hosts the Oracle DATA plane
 * (service oracle, plane data+onboard, exec false) and 8799 hosts the public
 * read server. Defaulting to either would make an unrelated healthy service
 * look like a reachable signer, which is the one lie this surface must not
 * tell. The signer must be named explicitly via ORACLE_SIGNER_URL.
 */
const REQUEST_TIMEOUT_MS = 4_000;

function signerBaseUrl(): string | null {
  const raw = (process.env.ORACLE_SIGNER_URL ?? "").trim();
  if (raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // Loopback only. A signer reachable over the network is not this product.
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
  return parsed.origin;
}

/**
 * A health body only counts as a signer when it identifies itself as one. The
 * data plane answers 200 on /health too, so a bare status code is not proof.
 *
 * Structural duck-typing is not proof either: accepting any loopback JSON that
 * merely carries an `armed` boolean or an `enabledSurfaces` array let a generic
 * or stale local service be reported as a reachable, ARMED signer. Require the
 * service to name itself.
 */
function looksLikeSigner(body: Record<string, unknown>): boolean {
  const service = typeof body.service === "string" ? body.service.toLowerCase() : "";
  return service === "oracle-signer" || service.includes("oracle-signer");
}

function unavailable(reason: string): OracleSignerStatus {
  return {
    configured: false,
    reachable: false,
    armed: false,
    surfaces: [] as string[],
    error: reason,
  };
}

export async function GET() {
  const base = signerBaseUrl();
  if (base === null) {
    return NextResponse.json(
      unavailable("Signer not configured. Set ORACLE_SIGNER_URL to the loopback oracle-signer daemon."),
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const res = await fetch(base + ORACLE_SIGNER_CONTRACT.routes.status.upstreamPath, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      return NextResponse.json(
        { ...unavailable("Signer responded " + res.status), configured: true },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (!looksLikeSigner(body)) {
      return NextResponse.json(
        {
          ...unavailable("ORACLE_SIGNER_URL points at a service that is not an oracle-signer"),
          configured: true,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    const surfaces = Array.isArray(body.enabledSurfaces)
      ? body.enabledSurfaces.filter((s): s is string => typeof s === "string")
      : [];
    return NextResponse.json(
      {
        configured: true,
        reachable: true,
        armed: body.armed === true,
        surfaces,
        error: null,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "Signer health check timed out"
        : "Signer is not running on loopback";
    return NextResponse.json(
      { ...unavailable(reason), configured: true },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
