// Oracle Control — public runtime config: chain/bundler/paymaster registry
// (Slice K).
//
// This module is pure config parsing. It never makes a live network call and
// never imports the private executor stack — its only job is to turn env
// vars into a validated, in-memory registry of PUBLIC endpoints (chain
// metadata, bundler URLs, paymaster URLs, and the public HTTP bind) that the
// rest of Oracle Control (aa-adapter.mjs, bundler-client.mjs, http.mjs) can
// read from.
//
// Hard boundaries for this file:
//   - Imports ONLY from ./aa-adapter.mjs (ENTRYPOINT_V07 — the single source
//     of truth for the deployed EntryPoint address this codebase targets)
//     and node builtins. NEVER from the private executor stack
//     (get-signer.mjs, keystore.mjs, exec-policy.mjs, local-signer/*,
//     adapters/*, mint-capability.mjs) — this module must never be wired to
//     private operator wallet, and holds no secrets of any kind.
//   - bundlerUrl/paymasterUrl are treated as PUBLIC endpoints (the same way a
//     public RPC URL is public) — but they are still scanned for anything
//     secret-SHAPED (a bearer token, an api-key-looking query param, a raw
//     private-key hex blob, a PEM block) and rejected outright if found.
//     Fail closed: a config that looks like it's carrying a credential in a
//     URL must never load.
//   - resolveChain() fails closed on any chainId not in the registry — no
//     silent fallback to a made-up chain.
//   - entryPoint is never read from env or invented; it is always pinned to
//     aa-adapter.mjs's ENTRYPOINT_V07 and asserted equal for every seeded
//     chain, so a typo/drift in this file can never point a chain at the
//     wrong EntryPoint deployment.
//   - redactedConfig() strips the query string (and any embedded userinfo)
//     off every bundler/paymaster URL before it is considered "safe to log"
//     — even though the full URL already passed the secret-shape scan at
//     load time, a log line is a wider blast radius than an in-memory
//     config object, so this view is deliberately more conservative.

import { ENTRYPOINT_V07 } from "./aa-adapter.mjs";

export class RuntimeConfigError extends Error {
  constructor(message) {
    super(`runtime-config: ${message}`);
    this.name = "RuntimeConfigError";
  }
}

function fail(message) {
  throw new RuntimeConfigError(message);
}

// ---------------------------------------------------------------------------
// Secret-shape guard for public endpoint URLs (fail closed)
// ---------------------------------------------------------------------------

/** String-value shapes that must never appear in a bundler/paymaster URL.
 *  Mirrors the posture of connect-agent.mjs's FORBIDDEN_VALUE_RULES /
 *  bundler-client.mjs's SecretLeakError checks, scoped to what a URL could
 *  plausibly carry (query-string credentials, embedded key material). */
const SECRET_URL_RULES = Object.freeze([
  // 32-byte hex — the shape of a raw EVM private key / session secret.
  { rule: "raw-32-byte-hex-key", re: /0x[0-9a-fA-F]{64}/ },
  { rule: "bearer-token", re: /bearer\s+[A-Za-z0-9._~+/=-]+/i },
  { rule: "pem-private-key", re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { rule: "authorization-header", re: /authorization\s*:/i },
  // Credential-shaped query/path segment: ?api_key=..., ?token=..., ?secret=...,
  // ?password=..., ?auth=..., ?access_token=..., ?bearer=..., or userinfo
  // (user:pass@host) embedded in the URL itself.
  {
    rule: "credential-shaped-param",
    re: /[?&](api[_-]?key|apikey|key|token|access[_-]?token|secret|password|passwd|auth|bearer)=/i,
  },
  { rule: "embedded-userinfo", re: /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i },
]);

function assertPublicUrlSafe(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(`${label} must be an http(s) URL, got scheme ${parsed.protocol}`);
  }
  for (const { rule, re } of SECRET_URL_RULES) {
    if (re.test(value)) {
      fail(`${label} looks like it carries secret material (rule: ${rule}) — refusing to load a credential-shaped public endpoint`);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Chain registry seed
// ---------------------------------------------------------------------------

/** Base metadata for every chain Oracle Control's public runtime config
 *  knows about out of the box. entryPoint is intentionally NOT stored here —
 *  it is always ENTRYPOINT_V07, asserted below, so there is exactly one
 *  place (aa-adapter.mjs) that can ever define it. */
const CHAIN_SEEDS = Object.freeze([
  { chainId: 8453, name: "Base" },
  { chainId: 42161, name: "Arbitrum" },
]);

export const DEFAULT_CHAIN_ID = 8453;
export const DEFAULT_PUBLIC_HOST = "127.0.0.1";
export const DEFAULT_PUBLIC_PORT = 8799;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function buildChainEntry(seed, env) {
  const entry = {
    name: seed.name,
    entryPoint: ENTRYPOINT_V07,
  };
  // entryPoint must always equal aa-adapter's ENTRYPOINT_V07 for every
  // supported chain — asserted here (not just "set here") so a future edit
  // that tries to override it per-chain is caught immediately.
  if (entry.entryPoint !== ENTRYPOINT_V07) {
    fail(`chain ${seed.chainId} entryPoint drifted from aa-adapter ENTRYPOINT_V07`);
  }

  const bundlerVar = `ORACLE_BUNDLER_URL_${seed.chainId}`;
  const paymasterVar = `ORACLE_PAYMASTER_URL_${seed.chainId}`;
  const bundlerRaw = env[bundlerVar];
  const paymasterRaw = env[paymasterVar];

  if (bundlerRaw != null && String(bundlerRaw).trim() !== "") {
    entry.bundlerUrl = assertPublicUrlSafe(String(bundlerRaw), bundlerVar);
  }
  if (paymasterRaw != null && String(paymasterRaw).trim() !== "") {
    entry.paymasterUrl = assertPublicUrlSafe(String(paymasterRaw), paymasterVar);
  }

  return entry;
}

function parsePort(raw, label) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    fail(`${label} must be an integer port 0-65535, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parsePublicHost(raw, label) {
  const host = String(raw).trim();
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(normalized)) {
    fail(`${label} must be a loopback host, got ${JSON.stringify(raw)}`);
  }
  return normalized === "::1" ? "::1" : host;
}

/**
 * Parse the public runtime config (chain/bundler/paymaster registry + public
 * HTTP bind) from an env-like object. Pure function, no I/O, no network.
 *
 * @param {object} [env] defaults to process.env; any plain object of
 *   string-ish values works (this is what makes it deterministically
 *   testable without touching real process.env).
 * @returns {{
 *   chains: Record<string, {name:string, entryPoint:string, bundlerUrl?:string, paymasterUrl?:string}>,
 *   defaultChainId: number,
 *   publicHost: string,
 *   publicPort: number,
 * }}
 */
export function loadPublicConfig(env = process.env) {
  if (env == null || typeof env !== "object") {
    fail("env must be an object");
  }

  const chains = {};
  for (const seed of CHAIN_SEEDS) {
    chains[String(seed.chainId)] = buildChainEntry(seed, env);
  }

  const rawDefaultChainId = env.ORACLE_DEFAULT_CHAIN_ID;
  let defaultChainId = DEFAULT_CHAIN_ID;
  if (rawDefaultChainId != null && String(rawDefaultChainId).trim() !== "") {
    const n = Number(rawDefaultChainId);
    if (!Number.isInteger(n)) {
      fail(`ORACLE_DEFAULT_CHAIN_ID must be an integer chain id, got ${JSON.stringify(rawDefaultChainId)}`);
    }
    if (chains[String(n)] == null) {
      fail(`ORACLE_DEFAULT_CHAIN_ID ${n} is not a registered chain (known: ${Object.keys(chains).join(", ")})`);
    }
    defaultChainId = n;
  }

  const publicHost = (() => {
    const v = env.ORACLE_PUBLIC_HOST ?? env.MAD_PUBLIC_HOST;
    return v != null && String(v).trim() !== "" ? parsePublicHost(v, "ORACLE_PUBLIC_HOST") : DEFAULT_PUBLIC_HOST;
  })();

  const publicPort = (() => {
    const v = env.ORACLE_PUBLIC_PORT ?? env.MAD_PUBLIC_PORT;
    if (v == null || String(v).trim() === "") return DEFAULT_PUBLIC_PORT;
    return parsePort(v, "ORACLE_PUBLIC_PORT");
  })();

  return Object.freeze({
    chains: Object.freeze(chains),
    defaultChainId,
    publicHost,
    publicPort,
  });
}

/**
 * Resolve a single chain entry from a loaded config. Fails closed on any
 * chainId not present in the registry — never falls back to a guessed/
 * default chain.
 *
 * @param {ReturnType<typeof loadPublicConfig>} config
 * @param {number|string} chainId
 */
export function resolveChain(config, chainId) {
  if (config == null || typeof config.chains !== "object") {
    fail("resolveChain: config must be a loadPublicConfig() result");
  }
  const key = String(chainId);
  const entry = config.chains[key];
  if (entry == null) {
    fail(`unsupported chainId ${key} (registered: ${Object.keys(config.chains).join(", ") || "none"})`);
  }
  return entry;
}

/** Drop the query string and any userinfo from a URL, keeping only
 *  scheme://host:port/path — safe to write to a log line even though the
 *  full URL already passed the load-time secret-shape scan. */
function redactUrl(value) {
  try {
    const u = new URL(value);
    u.search = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return "[unparseable-url-redacted]";
  }
}

/**
 * Safe-to-log view of a loaded config: chain names/entryPoints/host/port
 * pass through unchanged (none of that is secret-shaped), bundler/paymaster
 * URLs are stripped down to origin+path only.
 *
 * @param {ReturnType<typeof loadPublicConfig>} config
 */
export function redactedConfig(config) {
  if (config == null || typeof config.chains !== "object") {
    fail("redactedConfig: config must be a loadPublicConfig() result");
  }
  const chains = {};
  for (const [chainId, entry] of Object.entries(config.chains)) {
    chains[chainId] = {
      name: entry.name,
      entryPoint: entry.entryPoint,
      ...(entry.bundlerUrl != null ? { bundlerUrl: redactUrl(entry.bundlerUrl) } : {}),
      ...(entry.paymasterUrl != null ? { paymasterUrl: redactUrl(entry.paymasterUrl) } : {}),
    };
  }
  return Object.freeze({
    chains: Object.freeze(chains),
    defaultChainId: config.defaultChainId,
    publicHost: config.publicHost,
    publicPort: config.publicPort,
  });
}

export const _internal = { assertPublicUrlSafe, SECRET_URL_RULES, CHAIN_SEEDS };
