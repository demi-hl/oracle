import { ORACLE_DATA_PLANE } from "@oracle-agent/contract";

const DEFAULT_ORACLE_URL = ORACLE_DATA_PLANE.defaultBaseUrl;
const REQUEST_TIMEOUT_MS = 5_500;
const MAX_RESPONSE_CHARS = 1_000_000;

// Keep the bridge deliberately narrower than the Oracle data plane. There is no
// generic path or method export, so app routes cannot accidentally grow into an
// execution proxy.
type OracleReadPath =
  | typeof ORACLE_DATA_PLANE.routes.health.upstreamPath
  | typeof ORACLE_DATA_PLANE.routes.catalog.upstreamPath
  | typeof ORACLE_DATA_PLANE.routes.providerHealth.upstreamPath;

type SafeJson =
  | null
  | boolean
  | number
  | string
  | SafeJson[]
  | { [key: string]: SafeJson };

type CoverageState = "available" | "empty" | "unknown" | "unavailable";

export interface OracleCoverage {
  state: CoverageState;
  providerCount: number | null;
  healthyProviderCount: number | null;
  degradedProviderCount: number | null;
  unreachableProviderCount: number | null;
  unknownProviderCount: number | null;
  metadata: SafeJson | null;
  error: string | null;
}

interface OracleBridgeBase {
  configured: boolean;
  reachable: boolean;
  coverage: OracleCoverage;
  error: string | null;
  fetchedAt: string;
}

export interface OracleCatalogProvider {
  id: string;
  venue: string | null;
  chainIds: number[];
  auth: string | null;
  ops: string[];
  execution: string | null;
  description: string | null;
  metadata: SafeJson | null;
}

export interface OracleCatalogResult extends OracleBridgeBase {
  catalog: OracleCatalogProvider[];
}

export interface OracleProviderHealth {
  id: string;
  configured: boolean | null;
  reachable: boolean | null;
  healthy: boolean | null;
  status: "healthy" | "degraded" | "unreachable" | "unknown";
  latencyMs: number | null;
  error: string | null;
  detail: SafeJson | null;
}

export interface OracleHealthResult extends OracleBridgeBase {
  providers: OracleProviderHealth[];
}

export interface OracleStatusResult extends OracleBridgeBase {
  ok: boolean;
  service: string | null;
  plane: string | null;
  readOnly: boolean | null;
  version: string | null;
}

interface OracleConfig {
  configured: boolean;
  baseUrl: URL | null;
  error: string | null;
}

interface OracleFetchResult {
  configured: boolean;
  reachable: boolean;
  value: unknown;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveOracleConfig(): OracleConfig {
  const raw =
    process.env.ORACLE_API_URL?.trim() ||
    process.env.ORACLE_DATA_URL?.trim() ||
    DEFAULT_ORACLE_URL;

  try {
    const url = new URL(raw);
    if (!new Set(["http:", "https:"]).has(url.protocol)) {
      throw new Error("unsupported protocol");
    }
    // Credentials belong in server-side headers, never in a base URL that could
    // surface in fetch errors. The read bridge does not need credentials.
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("credentials, query strings, and fragments are not allowed");
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return { configured: true, baseUrl: url, error: null };
  } catch {
    return {
      configured: false,
      baseUrl: null,
      error: "Oracle data plane URL is invalid",
    };
  }
}

function requestUrl(baseUrl: URL, path: OracleReadPath): URL {
  return new URL(path.replace(/^\//, ""), baseUrl);
}

function conciseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;

  // Upstream errors occasionally contain endpoint URLs. Preserve the useful
  // reason while stripping locations, credentials, and credential-like values.
  text = text
    .replace(/https?:\/\/[^\s,)\]}]+/gi, "[redacted-url]")
    .replace(
      /((?:api[-_ ]?key|token|secret|password|authorization|cookie|credential)\s*(?:=|:))\s*[^\s,;]+/gi,
      "$1 [redacted]",
    );
  return text.slice(0, 220);
}

function errorFromPayload(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return conciseText(value.error) ?? conciseText(value.message) ?? null;
}

const SENSITIVE_KEY_PATTERNS = [
  "privatekey",
  "apikey",
  "secret",
  "token",
  "password",
  "authorization",
  "cookie",
  "credential",
  [109, 110, 101, 109, 111, 110, 105, 99].map((code) => String.fromCharCode(code)).join(""),
  "seed",
  "wif",
  "baseurl",
  "rpcurl",
  "endpointurl",
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/(present|configured|required|enabled|status)$/.test(normalized)) return false;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function sanitizeJson(value: unknown, depth = 0): SafeJson {
  if (depth > 8) return "[truncated]";
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return conciseText(value) ?? "";
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => sanitizeJson(item, depth + 1));
  if (!isRecord(value)) return String(value).slice(0, 220);

  const out: { [key: string]: SafeJson } = {};
  for (const [key, item] of Object.entries(value).slice(0, 1_000)) {
    out[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeJson(item, depth + 1);
  }
  return out;
}

async function fetchOracle(path: OracleReadPath): Promise<OracleFetchResult> {
  const config = resolveOracleConfig();
  if (!config.configured || !config.baseUrl) {
    return {
      configured: false,
      reachable: false,
      value: null,
      error: config.error,
    };
  }

  try {
    const response = await fetch(requestUrl(config.baseUrl, path), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      return {
        configured: true,
        reachable: true,
        value: null,
        error: "Oracle data plane response was too large",
      };
    }

    let value: unknown = null;
    if (text.trim()) {
      try {
        value = JSON.parse(text);
      } catch {
        return {
          configured: true,
          reachable: true,
          value: null,
          error: "Oracle data plane returned invalid JSON",
        };
      }
    }

    if (!response.ok) {
      const detail = errorFromPayload(value);
      return {
        configured: true,
        reachable: true,
        value,
        error: `Oracle data plane returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    return { configured: true, reachable: true, value, error: null };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const timedOut = name === "AbortError" || name === "TimeoutError";
    return {
      configured: true,
      reachable: false,
      value: null,
      error: timedOut
        ? "Oracle data plane request timed out"
        : "Oracle data plane is unreachable",
    };
  }
}

function emptyCoverage(
  state: CoverageState,
  error: string | null,
  metadata: SafeJson | null = null,
): OracleCoverage {
  return {
    state,
    providerCount: null,
    healthyProviderCount: null,
    degradedProviderCount: null,
    unreachableProviderCount: null,
    unknownProviderCount: null,
    metadata,
    error,
  };
}

function metadataFrom(value: unknown): SafeJson | null {
  if (!isRecord(value)) return null;
  const metadata: Record<string, unknown> = {};
  for (const key of ["coverage", "meta", "metadata", "when", "plane", "exec", "version"]) {
    if (key in value) metadata[key] = value[key];
  }
  return Object.keys(metadata).length ? sanitizeJson(metadata) : null;
}

function catalogArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;

  for (const key of ["catalog", "providers", "items", "results"]) {
    if (Array.isArray(value[key])) return value[key];
  }

  for (const key of ["data", "result"]) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
    if (isRecord(nested)) {
      for (const nestedKey of ["catalog", "providers", "items", "results"]) {
        if (Array.isArray(nested[nestedKey])) return nested[nestedKey];
      }
    }
  }
  return null;
}

function normalizeCatalogProvider(value: unknown): OracleCatalogProvider | null {
  if (!isRecord(value)) return null;
  const id = stringOrNull(value.id) ?? stringOrNull(value.name);
  if (!id) return null;

  const knownKeys = new Set([
    "id",
    "name",
    "venue",
    "chainIds",
    "chains",
    "auth",
    "ops",
    "operations",
    "execution",
    "description",
  ]);
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !knownKeys.has(key)));
  const rawChains = Array.isArray(value.chainIds)
    ? value.chainIds
    : Array.isArray(value.chains)
      ? value.chains
      : [];
  const rawOps = Array.isArray(value.ops)
    ? value.ops
    : Array.isArray(value.operations)
      ? value.operations
      : [];

  return {
    id,
    venue: stringOrNull(value.venue),
    chainIds: rawChains.filter(
      (chainId): chainId is number => typeof chainId === "number" && Number.isFinite(chainId),
    ),
    auth: stringOrNull(value.auth),
    ops: rawOps.filter((op): op is string => typeof op === "string"),
    execution: stringOrNull(value.execution),
    description: stringOrNull(value.description),
    metadata: Object.keys(extra).length ? sanitizeJson(extra) : null,
  };
}

function healthContainer(value: unknown): unknown[] | Record<string, unknown> | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;

  for (const key of ["providers", "health", "results", "items"]) {
    const candidate = value[key];
    if (Array.isArray(candidate) || isRecord(candidate)) return candidate;
  }

  for (const key of ["data", "result"]) {
    const nested = value[key];
    if (Array.isArray(nested)) return nested;
    if (isRecord(nested)) {
      for (const nestedKey of ["providers", "health", "results", "items"]) {
        const candidate = nested[nestedKey];
        if (Array.isArray(candidate) || isRecord(candidate)) return candidate;
      }
    }
  }
  return null;
}

function providerConfigured(row: Record<string, unknown>, detail: Record<string, unknown> | null) {
  for (const candidate of [
    row.configured,
    detail?.configured,
    detail?.apiKeyPresent,
    detail?.indexerConfigured,
  ]) {
    if (typeof candidate === "boolean") return candidate;
  }
  return null;
}

function providerError(
  row: Record<string, unknown>,
  detail: Record<string, unknown> | null,
): string | null {
  return (
    conciseText(row.error) ??
    conciseText(row.message) ??
    conciseText(detail?.error) ??
    conciseText(detail?.message) ??
    null
  );
}

function normalizeProviderHealth(value: unknown, fallbackId?: string): OracleProviderHealth | null {
  const row = isRecord(value) ? value : {};
  const id = stringOrNull(row.id) ?? stringOrNull(row.provider) ?? fallbackId ?? null;
  if (!id) return null;

  const detail = isRecord(row.detail) ? row.detail : null;
  const rowOk = booleanOrNull(row.ok);
  const detailOk = booleanOrNull(detail?.ok);
  const explicitReachable = booleanOrNull(row.reachable);
  const reachable = explicitReachable ?? rowOk;
  const explicitHealthy = booleanOrNull(row.healthy);
  const healthy =
    explicitHealthy ??
    (rowOk === true && detailOk !== false
      ? true
      : rowOk === false || detailOk === false
        ? false
        : null);

  let status: OracleProviderHealth["status"] = "unknown";
  if (reachable === false) status = "unreachable";
  else if (healthy === true) status = "healthy";
  else if (reachable === true && healthy === false) status = "degraded";

  return {
    id,
    configured: providerConfigured(row, detail),
    reachable,
    healthy,
    status,
    latencyMs: finiteNumberOrNull(row.ms) ?? finiteNumberOrNull(row.latencyMs),
    error: providerError(row, detail),
    detail: row.detail === undefined ? null : sanitizeJson(row.detail),
  };
}

function normalizeHealthProviders(value: unknown): OracleProviderHealth[] | null {
  const container = healthContainer(value);
  if (container === null) return null;
  if (Array.isArray(container)) {
    return container
      .map((row) => normalizeProviderHealth(row))
      .filter((row): row is OracleProviderHealth => row !== null);
  }
  return Object.entries(container)
    .map(([id, row]) => normalizeProviderHealth(row, id))
    .filter((row): row is OracleProviderHealth => row !== null);
}

function healthCoverage(
  providers: OracleProviderHealth[],
  metadata: SafeJson | null,
): OracleCoverage {
  return {
    state: providers.length ? "available" : "empty",
    providerCount: providers.length,
    healthyProviderCount: providers.filter((provider) => provider.status === "healthy").length,
    degradedProviderCount: providers.filter((provider) => provider.status === "degraded").length,
    unreachableProviderCount: providers.filter((provider) => provider.status === "unreachable").length,
    unknownProviderCount: providers.filter((provider) => provider.status === "unknown").length,
    metadata,
    error: null,
  };
}

export async function getOracleCatalog(): Promise<OracleCatalogResult> {
  const fetchedAt = new Date().toISOString();
  const response = await fetchOracle(ORACLE_DATA_PLANE.routes.catalog.upstreamPath);
  const rawCatalog = catalogArray(response.value);
  const metadata = metadataFrom(response.value);

  if (!response.reachable || response.error) {
    return {
      configured: response.configured,
      reachable: response.reachable,
      coverage: emptyCoverage("unavailable", response.error, metadata),
      catalog: [],
      error: response.error,
      fetchedAt,
    };
  }

  if (!rawCatalog) {
    const error = "Oracle catalog response did not contain a provider array";
    return {
      configured: response.configured,
      reachable: true,
      coverage: emptyCoverage("unknown", error, metadata),
      catalog: [],
      error,
      fetchedAt,
    };
  }

  const catalog = rawCatalog
    .map(normalizeCatalogProvider)
    .filter((provider): provider is OracleCatalogProvider => provider !== null);
  const coverage: OracleCoverage = {
    ...emptyCoverage(catalog.length ? "available" : "empty", null, metadata),
    providerCount: catalog.length,
  };
  return {
    configured: response.configured,
    reachable: true,
    coverage,
    catalog,
    error: null,
    fetchedAt,
  };
}

export async function getOracleHealth(): Promise<OracleHealthResult> {
  const fetchedAt = new Date().toISOString();
  const response = await fetchOracle(ORACLE_DATA_PLANE.routes.providerHealth.upstreamPath);
  const metadata = metadataFrom(response.value);

  if (!response.reachable || response.error) {
    return {
      configured: response.configured,
      reachable: response.reachable,
      coverage: emptyCoverage("unavailable", response.error, metadata),
      providers: [],
      error: response.error,
      fetchedAt,
    };
  }

  const providers = normalizeHealthProviders(response.value);
  if (!providers) {
    const error = "Oracle health response did not contain provider health data";
    return {
      configured: response.configured,
      reachable: true,
      coverage: emptyCoverage("unknown", error, metadata),
      providers: [],
      error,
      fetchedAt,
    };
  }

  return {
    configured: response.configured,
    reachable: true,
    coverage: healthCoverage(providers, metadata),
    providers,
    error: null,
    fetchedAt,
  };
}

export async function getOracleStatus(): Promise<OracleStatusResult> {
  const fetchedAt = new Date().toISOString();
  const [statusResponse, catalogResult] = await Promise.all([
    fetchOracle(ORACLE_DATA_PLANE.routes.health.upstreamPath),
    getOracleCatalog(),
  ]);
  const status = isRecord(statusResponse.value) ? statusResponse.value : {};
  const upstreamOk = booleanOrNull(status.ok);
  const upstreamExec = booleanOrNull(status.exec);
  const reachable = statusResponse.reachable || catalogResult.reachable;
  const configured = statusResponse.configured && catalogResult.configured;

  const readOnly = upstreamExec === null ? null : upstreamExec === false;
  const statusError =
    upstreamExec === true
      ? "Configured Oracle service is not a read-only data plane"
      : statusResponse.error;

  return {
    configured,
    reachable,
    coverage: catalogResult.coverage,
    ok: reachable && statusError === null && upstreamOk !== false,
    service: stringOrNull(status.service),
    plane: stringOrNull(status.plane),
    readOnly,
    version: stringOrNull(status.version),
    error: statusError,
    fetchedAt,
  };
}
