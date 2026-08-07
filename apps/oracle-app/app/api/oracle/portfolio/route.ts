import { NextRequest, NextResponse } from "next/server";
import { ORACLE_CHAINS, ORACLE_DATA_PLANE, ORACLE_EVM_CHAIN_IDS, type OracleChain } from "@oracle-agent/contract";
import {
  cappedRows,
  concentration,
  decimalAmount,
  flagImplausible,
  knownValue,
  priceKeyForRow,
  prunedRows,
  valueRows,
} from "./pricingLogic.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_PUBLIC_URL = "http://127.0.0.1:8799";
const REQUEST_TIMEOUT_MS = 90_000;
/**
 * Streaming ceiling. `response.text()` buffers without limit, so a
 * pathological upstream could exhaust memory before any size check runs.
 * Reading in bounded chunks caps the worst case while still admitting the
 * legitimately large responses a spam-heavy public wallet produces.
 */
const MAX_STREAM_CHARS = 24_000_000;
/**
 * Rows kept per chain after pruning. Dust and spam are unbounded on a public
 * address; genuine holdings are not. Anything beyond this is counted and
 * disclosed rather than silently dropped.
 */
const MAX_ROWS_PER_CHAIN = 60;
const LLAMA_PRICE_BASE = "https://coins.llama.fi/prices/current/";

type RecordLike = Record<string, unknown>;
type ChainState = "available" | "empty" | "degraded" | "unavailable" | "unconfigured";
type AddressFamily = "evm" | "solana" | "bitcoin";

interface SourceState {
  sourceId: string;
  status: string;
  error: string | null;
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

function safeAddress(value: string | null, family: AddressFamily): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (family === "evm") return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed : null;
  if (family === "solana") {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) ? trimmed : null;
  }
  const base58 = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
  const bech32 = /^bc1[ac-hj-np-z02-9]{11,71}$/i;
  return base58.test(trimmed) || bech32.test(trimmed) ? trimmed : null;
}

function addressFrom(request: NextRequest, queryKey: string, family: AddressFamily, envKeys: string[]): string | null {
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
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${ORACLE_DATA_PLANE.routes.portfolio.upstreamPath}`;
    return url;
  } catch {
    return null;
  }
}

/**
 * Read a response body with a hard ceiling.
 *
 * `response.text()` buffers without limit, so a pathological upstream could
 * exhaust memory before any size check runs. Reading in chunks bounds the
 * worst case and fails loudly at the ceiling rather than silently truncating
 * into invalid JSON.
 */
async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return response.text();

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > MAX_STREAM_CHARS) {
        throw new Error("Portfolio response exceeded the safe size limit");
      }
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function sourceRows(value: unknown): SourceState[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const sourceId = stringValue(item.sourceId);
    if (!sourceId) return [];
    const candidateStatus = stringValue(item.status) ?? "unknown";
    const status = new Set(["ok", "degraded", "unavailable", "unconfigured"]).has(candidateStatus)
      ? candidateStatus
      : "unknown";
    return [{ sourceId, status, error: concise(item.error) }];
  });
}

function rawRows(value: unknown): RecordLike[] {
  if (!isRecord(value)) return [];
  const portfolio = isRecord(value.portfolio) ? value.portfolio : null;
  return Array.isArray(portfolio?.rows) ? portfolio.rows.filter(isRecord) : [];
}

function chainForRow(row: RecordLike): OracleChain | null {
  const chainId = typeof row.chainId === "number" ? row.chainId : Number(row.chainId);
  if (Number.isFinite(chainId)) {
    const match = ORACLE_CHAINS.find((chain) => chain.chainId === chainId);
    if (match) return match;
  }
  const slug = stringValue(row.chain)?.toLowerCase();
  if (!slug) return null;
  return ORACLE_CHAINS.find((chain) => chain.id === slug) ?? null;
}

function normalizedRow(row: RecordLike, index: number) {
  const chain = chainForRow(row);
  if (!chain) return null;
  const kind = stringValue(row.kind) ?? "asset";
  const amount = stringValue(row.amount) ?? stringValue(row.sats) ?? stringValue(row.size) ?? stringValue(row.count);
  const decimals = typeof row.decimals === "number" && Number.isInteger(row.decimals) ? row.decimals : kind === "btc-utxo" ? 8 : null;
  const symbol = stringValue(row.symbol) ?? (kind === "native" || kind === "btc-utxo" ? chain.nativeSymbol : null);
  const candidateValueUsd = stringValue(row.valueUsd);
  const decimalUsd = candidateValueUsd !== null && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(candidateValueUsd);
  const numericValueUsd = decimalUsd ? Number(candidateValueUsd) : Number.NaN;
  const valueUsd = row.priced === true && Number.isFinite(numericValueUsd)
    ? candidateValueUsd
    : null;
  return {
    id: stringValue(row.id) ?? `${chain.id}:${kind}:${index}`,
    chainId: chain.id,
    chainNumericId: chain.chainId,
    kind,
    symbol,
    amount,
    decimals,
    valueUsd,
    priced: valueUsd !== null,
    address: stringValue(row.address) ?? stringValue(row.mint),
    collection: stringValue(row.collection),
  };
}

type PortfolioRow = NonNullable<ReturnType<typeof normalizedRow>>;

async function fetchLlamaPrices(rows: PortfolioRow[]) {
  const keys = [...new Set(rows.map(priceKeyForRow).filter((key): key is string => Boolean(key)))];
  const prices = new Map<string, number>();
  if (keys.length === 0) return { prices, reachable: true, requested: 0 };

  try {
    for (let index = 0; index < keys.length; index += 80) {
      const batch = keys.slice(index, index + 80);
      const response = await fetch(`${LLAMA_PRICE_BASE}${batch.join(",")}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`pricing HTTP ${response.status}`);
      const value: unknown = await response.json();
      const coins = isRecord(value) && isRecord(value.coins) ? value.coins : {};
      for (const key of batch) {
        const quote = isRecord(coins[key]) ? coins[key] : null;
        const price = quote && typeof quote.price === "number" ? quote.price : null;
        if (price !== null && Number.isFinite(price) && price > 0) prices.set(key, price);
      }
    }
    return { prices, reachable: true, requested: keys.length };
  } catch {
    return { prices, reachable: false, requested: keys.length };
  }
}

function sourceForFamily(chain: OracleChain): string[] {
  if (chain.family === "solana") return ["solana-spl", "solana-native"];
  if (chain.family === "bitcoin") return ["bitcoin-utxo"];
  if (chain.family === "hyperliquid") return ["perps-hl"];
  // Chain badges describe fungible balance visibility. LP and NFT provider
  // gaps remain disclosed in aggregate coverage without marking every balance
  // source as failed.
  return ["evm-native", "evm-erc20"];
}

function chainSourceStatus(source: SourceState, chain: OracleChain): string {
  if (!chain.chainId || !source.error || source.status !== "degraded") return source.status;
  return new RegExp(`(?:^|; )chain ${chain.chainId}:`).test(source.error) ? "degraded" : "ok";
}

function chainState(chain: OracleChain, sources: SourceState[], rowCount: number): ChainState {
  const relevant = sourceForFamily(chain)
    .map((id) => sources.find((source) => source.sourceId === id))
    .filter((source): source is SourceState => Boolean(source))
    .map((source) => chainSourceStatus(source, chain));
  if (rowCount > 0) return relevant.some((state) => state !== "ok") ? "degraded" : "available";
  if (relevant.length === 0) return "unavailable";
  if (relevant.every((state) => state === "unconfigured")) return "unconfigured";
  if (relevant.every((state) => state === "unavailable")) return "unavailable";
  if (relevant.some((state) => state === "unknown")) return "unavailable";
  if (relevant.some((state) => state === "degraded" || state === "unavailable")) return "degraded";
  return relevant.every((state) => state === "ok") ? "empty" : "unavailable";
}

function unavailableResponse(error: string, configured = true) {
  return {
    configured,
    reachable: false,
    error,
    fetchedAt: new Date().toISOString(),
    totals: { valueUsd: null, complete: false, assetCount: 0, pricedCount: 0, unpricedCount: 0 },
    rows: [],
    chains: ORACLE_CHAINS.map((chain) => ({ ...chain, state: configured ? "unavailable" : "unconfigured", assetCount: 0, valueUsd: null, unpricedCount: 0 })),
    coverage: null,
  };
}

export async function GET(request: NextRequest) {
  const evm = addressFrom(request, "evm", "evm", ["ORACLE_PORTFOLIO_EVM_ADDRESS", "ORACLE_EVM_ADDRESS"]);
  const solana = addressFrom(request, "solana", "solana", ["ORACLE_PORTFOLIO_SOLANA_ADDRESS", "ORACLE_SOLANA_ADDRESS"]);
  const bitcoin = addressFrom(request, "bitcoin", "bitcoin", ["ORACLE_PORTFOLIO_BITCOIN_ADDRESS", "ORACLE_BITCOIN_ADDRESS"]);
  const hyperliquid = addressFrom(request, "hyperliquid", "evm", ["ORACLE_PORTFOLIO_HYPERLIQUID_ADDRESS", "ORACLE_HYPERLIQUID_ADDRESS"]) ?? evm;
  const owner = Object.fromEntries(Object.entries({ evm, solana, bitcoin, hyperliquid }).filter(([, value]) => value));

  if (Object.keys(owner).length === 0) {
    return NextResponse.json(unavailableResponse("Add at least one public wallet address to view a portfolio", false), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const url = upstreamUrl();
  if (!url) {
    return NextResponse.json(unavailableResponse("Oracle portfolio service URL is invalid"), {
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
    const text = await readBounded(response);
    let value: unknown = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      throw new Error("Portfolio service returned invalid JSON");
    }
    if (!response.ok) {
      const detail = isRecord(value) ? concise(value.error) ?? concise(value.message) : null;
      throw new Error(detail ?? `Portfolio service returned HTTP ${response.status}`);
    }

    const sources = sourceRows(isRecord(value) ? value.sources : null);
    // The desk currently exposes SPL token accounts but not native SOL. Keep
    // that gap explicit so a configured Solana address is never presented as a
    // complete chain balance.
    sources.push({
      sourceId: "solana-native",
      status: owner.solana ? "unavailable" : "unconfigured",
      error: owner.solana
        ? "native SOL balance is not exposed by the configured public portfolio source"
        : "no solana owner address",
    });
    const upstreamRows = rawRows(value);
    const pruned = prunedRows(upstreamRows);
    const normalizedRows = pruned.rows
      .map(normalizedRow)
      .filter((row): row is PortfolioRow => row !== null);
    const pricing = await fetchLlamaPrices(normalizedRows);
    const priced = valueRows(normalizedRows, pricing.prices);
    // Last line of defence for the wrong-number bug class: a row priced above
    // any plausible single position is a pricing fault, not a fortune. Flagged
    // rows keep their data for display but leave the headline total.
    const screened = flagImplausible(priced);
    const capped = cappedRows(screened.rows);
    const rows = capped.rows;
    const shape = concentration(rows);
    const portfolio = isRecord(value) && isRecord(value.portfolio) ? value.portfolio : {};
    const chains = ORACLE_CHAINS.map((chain) => {
      const chainRows = rows.filter((row) => row.chainId === chain.id);
      return {
        ...chain,
        state: chainState(chain, sources, chainRows.length),
        assetCount: chainRows.length,
        valueUsd: knownValue(chainRows),
        unpricedCount: chainRows.filter((row) => !row.priced).length,
      };
    });
    const coverage = isRecord(portfolio.coverage)
      ? {
          operational: portfolio.coverage.operational === true,
          complete: portfolio.coverage.complete === true && !owner.solana,
          hasGaps: portfolio.coverage.hasGaps !== false || Boolean(owner.solana),
          degraded: Array.isArray(portfolio.coverage.degraded) ? portfolio.coverage.degraded.filter((item): item is string => typeof item === "string") : [],
          unavailable: [
            ...(Array.isArray(portfolio.coverage.unavailable) ? portfolio.coverage.unavailable.filter((item): item is string => typeof item === "string") : []),
            ...(owner.solana ? ["solana-native"] : []),
          ],
          unconfigured: [
            ...(Array.isArray(portfolio.coverage.unconfigured) ? portfolio.coverage.unconfigured.filter((item): item is string => typeof item === "string") : []),
            ...(!owner.solana ? ["solana-native"] : []),
          ],
        }
      : null;

    return NextResponse.json({
      configured: true,
      reachable: true,
      error: null,
      fetchedAt: new Date().toISOString(),
      generatedAt: stringValue(portfolio.generatedAt),
      addressFamilies: Object.keys(owner),
      totals: {
        valueUsd: knownValue(rows),
        complete:
          rows.every((row) => row.priced) &&
          coverage?.complete === true &&
          // Rows cut by the per-chain cap and rows excluded as implausible are
          // both omissions from the headline number. A total computed from a
          // subset is not "complete" just because every retained row happened
          // to be priced, so fold those into the flag the UI reads.
          capped.truncated === 0 &&
          screened.suspectCount === 0,
        assetCount: rows.length,
        pricedCount: rows.filter((row) => row.priced).length,
        unpricedCount: rows.filter((row) => !row.priced).length,
      },
      rows,
      chains,
      // Pruning and capping are disclosed, never silent. `dustDropped` is
      // zero-balance noise removed before pricing; `truncated` is real rows cut
      // by the per-chain cap. Both leave the total intact.
      pruning: {
        upstreamRows: upstreamRows.length,
        dustDropped: pruned.dropped,
        truncated: capped.truncated,
        maxRowsPerChain: MAX_ROWS_PER_CHAIN,
        complete: capped.truncated === 0,
      },
      // Integrity signals for the headline number. `suspectCount` rows were
      // excluded from the total as implausible; `concentrated` says the total
      // rests almost entirely on one position, which is legitimate but worth
      // stating rather than implying breadth.
      integrity: {
        suspectCount: screened.suspectCount,
        topPositionRatio: shape ? Number(shape.ratio.toFixed(4)) : null,
        concentrated: shape?.concentrated ?? false,
      },
      coverage: coverage ? {
        ...coverage,
        pricing: {
          provider: "DeFiLlama",
          reachable: pricing.reachable,
          requested: pricing.requested,
          resolved: pricing.prices.size,
        },
      } : null,
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError"
      ? "Oracle portfolio request timed out"
      : concise(error instanceof Error ? error.message : null) ?? "Oracle portfolio service is unavailable";
    return NextResponse.json(unavailableResponse(reason), {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
