import { NextRequest, NextResponse } from "next/server";
import {
  ORACLE_CHAINS,
  ORACLE_DATA_PLANE,
  ORACLE_EVM_CHAIN_IDS,
  type OracleApproval,
  type OracleApprovalRisk,
  type OracleApprovalStandard,
  ORACLE_UNLIMITED_FLOOR,
  oracleAllowanceDisplay,
  oracleApprovalRisk,
} from "@oracle-agent/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Token approval REVIEW. Read-only and address-based. This route reads public
 * allowance state for an address the caller supplies. It never signs, never
 * broadcasts, and never takes custody. Revoking is a separate prepare-only
 * route whose output a user's own wallet must sign.
 */
const DEFAULT_PUBLIC_URL = "http://127.0.0.1:8799";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_CHARS = 2_000_000;
const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;
const UINT256_MAX = (1n << 256n) - 1n;
/** Allowances at or above this are effectively unbounded for any real supply. */
const UNLIMITED_FLOOR = UINT256_MAX / 2n;

type RecordLike = Record<string, unknown>;
type ChainScanState = "available" | "empty" | "degraded" | "unavailable" | "unconfigured";

interface ChainScan {
  id: string;
  label: string;
  shortLabel: string;
  accent: string;
  chainId: number | null;
  state: ChainScanState;
  approvalCount: number;
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function concise(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https?:\/\/[^\s,)\]}]+/gi, "[upstream]")
    .replace(/((?:api[-_ ]?key|token|secret|password|authorization|cookie|credential)\s*(?:=|:))\s*[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 280) : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function evmAddress(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed : null;
}

function ownerFrom(request: NextRequest): string | null {
  const fromQuery = evmAddress(request.nextUrl.searchParams.get("evm"));
  if (fromQuery) return fromQuery;
  for (const key of ["ORACLE_PORTFOLIO_EVM_ADDRESS", "ORACLE_EVM_ADDRESS"]) {
    const fromEnv = evmAddress(process.env[key] ?? null);
    if (fromEnv) return fromEnv;
  }
  return null;
}

function upstreamUrl(): URL | null {
  try {
    const raw = process.env.ORACLE_PUBLIC_URL?.trim() || DEFAULT_PUBLIC_URL;
    const url = new URL(raw);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${ORACLE_DATA_PLANE.routes.approvals.upstreamPath}`;
    return url;
  } catch {
    return null;
  }
}

function bigintOrNull(value: unknown): bigint | null {
  const text = stringValue(value);
  if (text === null) return null;
  try {
    if (/^0x[0-9a-fA-F]+$/.test(text)) return BigInt(text);
    if (/^\d+$/.test(text)) return BigInt(text);
    return null;
  } catch {
    return null;
  }
}

function normalizedApproval(row: RecordLike, index: number): OracleApproval | null {
  const token = evmAddress(stringValue(row.token) ?? stringValue(row.tokenAddress));
  const spender = evmAddress(stringValue(row.spender));
  if (!token || !spender) return null;

  const numericChainId = Number(row.chainId);
  const chain = Number.isFinite(numericChainId)
    ? ORACLE_CHAINS.find((item) => item.chainId === numericChainId)
    : ORACLE_CHAINS.find((item) => item.id === stringValue(row.chain)?.toLowerCase());
  if (!chain) return null;

  const standard: OracleApprovalStandard = row.standard === "erc721" ? "erc721" : "erc20";
  // An operator grant carries no amount, so the ERC-20 "must be positive" gate
  // would silently discard every NFT approval. Liveness for that shape was
  // already established upstream by isApprovedForAll returning true.
  const allowance = bigintOrNull(row.allowance ?? row.value);
  if (standard === "erc20" && (allowance === null || allowance <= 0n)) return null;

  const decimals = typeof row.decimals === "number" && Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 36
    ? row.decimals
    : null;
  const unlimited = standard === "erc721" ? true : (allowance as bigint) >= ORACLE_UNLIMITED_FLOOR;
  const spenderLabel = stringValue(row.spenderLabel) ?? stringValue(row.protocol);
  const lastActivityAt = stringValue(row.lastActivityAt);

  return {
    id: stringValue(row.id) ?? `${chain.id}:${token}:${spender}:${index}`,
    chainId: chain.id,
    chainNumericId: chain.chainId,
    standard,
    token,
    tokenSymbol: stringValue(row.symbol) ?? stringValue(row.tokenSymbol),
    spender,
    spenderLabel,
    allowance: allowance === null ? null : allowance.toString(),
    allowanceDisplay: oracleAllowanceDisplay(allowance, decimals, standard),
    unlimited,
    decimals,
    lastActivityAt,
    risk: oracleApprovalRisk({ standard, unlimited, spenderLabel, lastActivityAt }),
  };
}

function scanRows(value: unknown): Map<string, ChainScanState> {
  const states = new Map<string, ChainScanState>();
  if (!isRecord(value) || !Array.isArray(value.scans)) return states;
  for (const item of value.scans) {
    if (!isRecord(item)) continue;
    const numericChainId = Number(item.chainId);
    const chain = Number.isFinite(numericChainId)
      ? ORACLE_CHAINS.find((entry) => entry.chainId === numericChainId)
      : ORACLE_CHAINS.find((entry) => entry.id === stringValue(item.chain)?.toLowerCase());
    if (!chain) continue;
    const status = stringValue(item.status);
    if (status === "ok") states.set(chain.id, "available");
    else if (status === "degraded") states.set(chain.id, "degraded");
    else if (status === "unconfigured") states.set(chain.id, "unconfigured");
    else states.set(chain.id, "unavailable");
  }
  return states;
}

function evmChains() {
  return ORACLE_CHAINS.filter((chain) => chain.family === "evm");
}

function chainScans(states: Map<string, ChainScanState>, approvals: OracleApproval[]): ChainScan[] {
  return evmChains().map((chain) => {
    const approvalCount = approvals.filter((item) => item.chainId === chain.id).length;
    const reported = states.get(chain.id);
    const state: ChainScanState = approvalCount > 0
      ? (reported === "degraded" ? "degraded" : "available")
      : reported === "available"
        ? "empty"
        : reported ?? "unavailable";
    return {
      id: chain.id,
      label: chain.label,
      shortLabel: chain.shortLabel,
      accent: chain.accent,
      chainId: chain.chainId,
      state,
      approvalCount,
    };
  });
}

function unavailableResponse(error: string, configured = true) {
  return {
    configured,
    reachable: false,
    error,
    fetchedAt: new Date().toISOString(),
    owner: null,
    scannedRange: null,
    totals: { approvalCount: 0, unlimitedCount: 0, staleCount: 0, chainsScanned: 0 },
    approvals: [] as OracleApproval[],
    chains: evmChains().map((chain) => ({
      id: chain.id,
      label: chain.label,
      shortLabel: chain.shortLabel,
      accent: chain.accent,
      chainId: chain.chainId,
      state: configured ? "unavailable" : "unconfigured",
      approvalCount: 0,
    })),
    custody: { requiresWalletSignature: true, backendSigner: false } as const,
  };
}

export async function GET(request: NextRequest) {
  const owner = ownerFrom(request);
  if (!owner) {
    return NextResponse.json(
      unavailableResponse("Add a public EVM address to review token approvals", false),
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = upstreamUrl();
  if (!url) {
    return NextResponse.json(unavailableResponse("Oracle approvals service URL is invalid"), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ owner, chainIds: ORACLE_EVM_CHAIN_IDS }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new Error("Approvals response exceeded the safe size limit");
    }
    let value: unknown = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("Approvals service returned invalid JSON");
    }
    if (!response.ok) {
      const detail = isRecord(value) ? concise(value.error) ?? concise(value.message) : null;
      throw new Error(detail ?? `Approvals service returned HTTP ${response.status}`);
    }

    const rawRows = isRecord(value) && Array.isArray(value.approvals) ? value.approvals.filter(isRecord) : [];
    const approvals = rawRows
      .map(normalizedApproval)
      .filter((row): row is OracleApproval => row !== null)
      .sort((a, b) => {
        // Operator grants first: uncapped across an entire collection.
        const operatorA = a.risk === "operator-all";
        const operatorB = b.risk === "operator-all";
        if (operatorA !== operatorB) return operatorA ? -1 : 1;
        if (a.unlimited !== b.unlimited) return a.unlimited ? -1 : 1;
        return a.chainId.localeCompare(b.chainId);
      });
    const chains = chainScans(scanRows(value), approvals);

    return NextResponse.json(
      {
        configured: true,
        reachable: true,
        error: null,
        fetchedAt: new Date().toISOString(),
        owner,
        scannedRange: stringValue(isRecord(value) ? value.scannedRange : null),
        totals: {
          approvalCount: approvals.length,
          unlimitedCount: approvals.filter((row) => row.unlimited).length,
          operatorCount: approvals.filter((row) => row.risk === "operator-all").length,
          staleCount: approvals.filter((row) => row.risk === "stale").length,
          chainsScanned: chains.filter((chain) => chain.state === "available" || chain.state === "empty").length,
        },
        approvals,
        chains,
        custody: { requiresWalletSignature: true, backendSigner: false },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError"
      ? "Oracle approvals request timed out"
      : concise(error instanceof Error ? error.message : null) ?? "Oracle approvals service is unavailable";
    return NextResponse.json(unavailableResponse(reason), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
