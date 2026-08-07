import { NextRequest, NextResponse } from "next/server";
import { ORACLE_CHAINS, ORACLE_DATA_PLANE, ORACLE_EVM_CHAIN_IDS, type OracleChain } from "@oracle-agent/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PUBLIC_URL = "http://127.0.0.1:8799";
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_CHARS = 2_000_000;

type RecordLike = Record<string, unknown>;

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

function safeAddress(value: string | null, family: "evm" | "solana"): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (family === "evm") return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed : null;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) ? trimmed : null;
}

function addressFrom(request: NextRequest, queryKey: string, family: "evm" | "solana", envKeys: string[]): string | null {
  const fromQuery = safeAddress(request.nextUrl.searchParams.get(queryKey), family);
  if (fromQuery) return fromQuery;
  for (const key of envKeys) {
    const fromEnv = safeAddress(process.env[key] ?? null, family);
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
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${ORACLE_DATA_PLANE.routes.nfts.upstreamPath}`;
    return url;
  } catch {
    return null;
  }
}

function chainForRow(row: RecordLike): OracleChain | null {
  const numericId = typeof row.chainId === "number" ? row.chainId : Number(row.chainId);
  if (Number.isFinite(numericId)) {
    const match = ORACLE_CHAINS.find((chain) => chain.chainId === numericId);
    if (match) return match;
  }
  const candidate = (stringValue(row.chain) ?? stringValue(row.chainId))?.toLowerCase();
  return candidate ? ORACLE_CHAINS.find((chain) => chain.id === candidate) ?? null : null;
}

function safeImageUrl(value: unknown): string | null {
  const candidate = stringValue(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizedItem(row: RecordLike) {
  const chain = chainForRow(row);
  const collection = stringValue(row.collection) ?? stringValue(row.collectionName);
  const name = stringValue(row.name) ?? stringValue(row.tokenName);
  const tokenId = stringValue(row.tokenId) ?? stringValue(row.token_id);
  const id = stringValue(row.id) ?? stringValue(row.assetId);
  if (!chain || !collection || !tokenId || (!id && !name)) return null;
  const floorCandidate = stringValue(row.floorUsd) ?? stringValue(row.floorValueUsd);
  const floorNumber = floorCandidate === null ? Number.NaN : Number(floorCandidate);
  return {
    id: id ?? `${chain.id}:${collection}:${tokenId}`,
    chainId: chain.id,
    collection,
    name,
    tokenId,
    imageUrl: safeImageUrl(row.imageUrl ?? row.image ?? row.thumbnailUrl),
    floorUsd: Number.isFinite(floorNumber) && floorNumber >= 0 ? floorCandidate : null,
  };
}

function rawItems(value: unknown): RecordLike[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) return value.items.filter(isRecord);
  const nfts = isRecord(value.nfts) ? value.nfts : null;
  return Array.isArray(nfts?.items) ? nfts.items.filter(isRecord) : [];
}

function coverageFrom(value: unknown): RecordLike | null {
  if (!isRecord(value)) return null;
  const nfts = isRecord(value.nfts) ? value.nfts : null;
  const coverage = isRecord(nfts?.coverage) ? nfts.coverage : isRecord(value.coverage) ? value.coverage : null;
  if (!coverage) return null;
  return {
    operational: coverage.operational === true,
    complete: coverage.complete === true,
    hasGaps: coverage.hasGaps === true,
    degraded: Array.isArray(coverage.degraded) ? coverage.degraded.filter((item): item is string => typeof item === "string") : [],
    unavailable: Array.isArray(coverage.unavailable) ? coverage.unavailable.filter((item): item is string => typeof item === "string") : [],
    unconfigured: Array.isArray(coverage.unconfigured) ? coverage.unconfigured.filter((item): item is string => typeof item === "string") : [],
  };
}

function unavailableResponse(error: string, configured = true) {
  return {
    configured,
    reachable: false,
    error,
    fetchedAt: new Date().toISOString(),
    totals: { count: 0, collectionCount: 0 },
    items: [],
    coverage: null,
  };
}

export async function GET(request: NextRequest) {
  const evm = addressFrom(request, "evm", "evm", ["ORACLE_PORTFOLIO_EVM_ADDRESS", "ORACLE_EVM_ADDRESS"]);
  const solana = addressFrom(request, "solana", "solana", ["ORACLE_PORTFOLIO_SOLANA_ADDRESS", "ORACLE_SOLANA_ADDRESS"]);
  const owner = Object.fromEntries(Object.entries({ evm, solana }).filter(([, value]) => value));

  if (Object.keys(owner).length === 0) {
    return NextResponse.json(unavailableResponse("Add a public EVM or Solana wallet address to view NFTs", false), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const url = upstreamUrl();
  if (!url) {
    return NextResponse.json(unavailableResponse("Oracle NFT service URL is invalid", false), {
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
    if (text.length > MAX_RESPONSE_CHARS) throw new Error("NFT response exceeded the safe size limit");
    let value: unknown = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("NFT service returned invalid JSON");
    }
    if (!response.ok) {
      const detail = isRecord(value) ? concise(value.error) ?? concise(value.message) : null;
      throw new Error(detail ?? `NFT service returned HTTP ${response.status}`);
    }

    const items = rawItems(value).map(normalizedItem).filter((item): item is NonNullable<ReturnType<typeof normalizedItem>> => item !== null);
    return NextResponse.json({
      configured: true,
      reachable: true,
      error: null,
      fetchedAt: new Date().toISOString(),
      totals: {
        count: items.length,
        collectionCount: new Set(items.map((item) => `${item.chainId}:${item.collection}`)).size,
      },
      items,
      coverage: coverageFrom(value),
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError"
      ? "Oracle NFT request timed out"
      : concise(error instanceof Error ? error.message : null) ?? "Oracle NFT service is unavailable";
    return NextResponse.json(unavailableResponse(reason, false), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
