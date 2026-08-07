// Oracle Public HTTP surface (Slice G) — secret-free BFF over the public
// read/assemble contract.
//
// Hard boundaries for this file:
//   - Imports ONLY the public API/peer modules (connect-agent, grants,
//     policy-schema, oracle-env). NEVER the private executor stack
//     (get-signer, keystore, exec-policy, local-signer/*, adapters/*,
//     exec-server, mint-capability).
//   - NEVER signs anything and NEVER holds key material. Every payload this
//     server emits is unsigned public data; the user signs client-side.
//   - Fail-closed no-secret invariant: EVERY response body is recursively
//     scanned with assertNoSecretMaterial() before it is written to the
//     socket. If the scan throws, the body is dropped and the client gets
//     500 { error: "secret-leak-blocked" } instead. The model proposes,
//     the owner authorizes.
//   - No auth secrets in code: this plane serves public reads/assembly only,
//     binds to loopback by default, and carries no bearer/token logic.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildConnectRequest,
  assembleUnsignedGrant,
  assertNoSecretMaterial,
  assertSerializedNoSecrets,
  SecretLeakError,
} from "./connect-agent.mjs";
import { listActiveGrants, getGrant } from "./grants.mjs";
import { GrantValidationError } from "../public-control/policy-schema.mjs";
import { approvalsScan } from "../data/providers/approvals.mjs";
import { portfolioBalance } from "../data/providers/portfolio.mjs";
import { nftInventory } from "../data/providers/nft-portfolio.mjs";
import { env } from "../oracle-env.mjs";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
);

export const PUBLIC_PLANE = "public";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8799;
export const VERSION = pkg.version;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CONSOLE_DIR = join(ROOT_DIR, "public", "oracle-console");

/** Allowlisted console static files only — no directory listing / traversal. */
const STATIC_FILES = Object.freeze({
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/oracle-console": { file: "index.html", type: "text/html; charset=utf-8" },
  "/oracle-console/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/oracle-console/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/oracle-console/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/oracle-console/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
});

/** Refuse absurd bodies before parsing (fail closed, cheap DoS guard). */
const MAX_BODY_BYTES = 1_000_000;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/**
 * Write a JSON response. The no-secret invariant runs HERE, on every body,
 * immediately before the bytes hit the socket.
 *
 * Two layers, in order:
 *   1. assertNoSecretMaterial() walks the object graph (precise path in the
 *      error, catches forbidden key names on real properties).
 *   2. assertSerializedNoSecrets() scans the ACTUAL JSON bytes we are about to
 *      write. This is the authoritative check: toJSON(), getters, symbol keys
 *      and non-enumerable properties can all put a value on the wire that the
 *      graph walk never visited.
 *
 * If either throws, the original body is never serialized to the client; a
 * fixed 500 secret-leak-blocked envelope is sent instead.
 */
function send(res, status, body) {
  let payloadStatus = status;
  let json;
  try {
    assertNoSecretMaterial(body);
    json = assertSerializedNoSecrets(body);
  } catch {
    payloadStatus = 500;
    json = JSON.stringify({ error: "secret-leak-blocked" });
  }
  res.writeHead(payloadStatus, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-oracle-plane": PUBLIC_PLANE,
    "x-oracle-unsigned": "true",
  });
  res.end(json);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "payload-too-large", "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "invalid-json", "request body must be valid JSON"));
      }
    });
    req.on("error", () => reject(new HttpError(400, "bad-request", "request stream error")));
  });
}

function asPlainObject(v, code) {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new HttpError(400, code, `${code} must be a JSON object`);
  }
  return v;
}

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function assertLoopbackBindHost(host) {
  const normalized = normalizeHost(host);
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new TypeError(`oracle-public only binds loopback hosts; got ${String(host)}`);
  }
  return normalized === "::1" ? "::1" : String(host).trim();
}

// ---------------------------------------------------------------------------
// Route handlers — each returns { status, body }; errors are thrown.
// ---------------------------------------------------------------------------

function handleHealth() {
  return { status: 200, body: { ok: true, plane: PUBLIC_PLANE, version: VERSION } };
}

function serverTimeOptions(clientOpts) {
  return {
    ...clientOpts,
    allowWildcardActions: false,
    now: Math.floor(Date.now() / 1000),
  };
}

function handleConnectRequest(body) {
  const b = asPlainObject(body, "body");
  // Accept either { input, opts } or the raw grant fields as the body itself.
  // Caller opts.now is deliberately overwritten by serverTimeOptions().
  const input = b.input !== undefined ? asPlainObject(b.input, "input") : b;
  const opts = serverTimeOptions(asPlainObject(b.opts, "opts"));
  const rawInput = input === b ? (({ opts: _drop, ...rest }) => rest)(b) : input;
  return { status: 200, body: buildConnectRequest(rawInput, opts) };
}

function handleConnectAssemble(body) {
  const b = asPlainObject(body, "body");
  const input =
    b.request !== undefined
      ? asPlainObject(b.request, "request")
      : b.input !== undefined
        ? asPlainObject(b.input, "input")
        : b;
  const opts = serverTimeOptions(asPlainObject(b.opts, "opts"));
  const rawInput = input === b ? (({ opts: _drop, ...rest }) => rest)(b) : input;
  return { status: 200, body: assembleUnsignedGrant(rawInput, opts) };
}

function handleGrantsActive(body) {
  const b = asPlainObject(body, "body");
  const opts = serverTimeOptions(asPlainObject(b.opts, "opts"));
  const grants = listActiveGrants(b.store ?? [], opts);
  return { status: 200, body: { ok: true, count: grants.length, grants } };
}

function handleGrantsGet(body) {
  const b = asPlainObject(body, "body");
  const opts = serverTimeOptions(asPlainObject(b.opts, "opts"));
  const found = getGrant(b.store ?? [], b.id, opts);
  if (found == null) {
    return { status: 404, body: { error: "grant-not-found" } };
  }
  return { status: 200, body: found };
}

/**
 * Public runtime config for the browser console.
 *
 * Advertises which wallet-connection modes this deployment supports so the frontend
 * does not have to guess or hardcode. Two modes, both self-custodial:
 *
 *   injected  EIP-1193 / EIP-6963 browser wallet (MetaMask, Rabby, ...)
 *   privy     embedded/social login, still user-held keys
 *
 * A Privy APP ID is a PUBLIC client identifier -- it is designed to ship in
 * frontend bundles. The app SECRET is server-side and must never appear here, which
 * is why only the id is read and the send() path runs a secret scan over every
 * response body regardless.
 *
 * Absent env means the mode is simply unavailable. Reporting it as disabled is
 * honest; inventing a default app id would produce a broken login flow.
 */
function handleConfig() {
  const privyAppId = (process.env.ORACLE_PRIVY_APP_ID || process.env.PRIVY_APP_ID || "").trim();
  const privyEnabled = privyAppId.length > 0;
  // Injected wallets need no server config, so this deployment can always offer it.
  const injectedEnabled = true;

  const modes = [];
  if (privyEnabled) modes.push("privy");
  if (injectedEnabled) modes.push("injected");

  return {
    status: 200,
    body: {
      ok: true,
      plane: PUBLIC_PLANE,
      version: VERSION,
      custody: {
        // Stated explicitly: no deployment of the public plane ever holds keys.
        selfCustodial: true,
        signer: "user-wallet",
        privyEnabled,
        injectedEnabled,
        modes,
      },
      privy: {
        // Public client id only. Never the app secret.
        appId: privyAppId || null,
      },
    },
  };
}

/**
 * Read-only ERC-20 approval review.
 *
 * Log-derived and range-scoped by construction, so the response carries its
 * own scan range and never implies completeness. Revoking is a separate
 * prepare-only surface whose output the user's wallet signs.
 */
/**
 * Read-only approval review.
 *
 * Amplification-aware: a single request fans out to many upstream RPC calls, so
 * the chain list is capped here as well as rate-limited at the dispatcher. An
 * uncapped `chainIds` array would let one request cost as much as many.
 */
const MAX_CHAINS_PER_REQUEST = 12;

async function handleApprovals(body) {
  const b = asPlainObject(body, "body");
  const owner = typeof b.owner === "string" ? b.owner : null;
  if (!owner) throw new HttpError(400, "owner-required", "owner must be an EVM address");
  const requested = Array.isArray(b.chainIds) ? b.chainIds.map(Number).filter(Number.isFinite) : undefined;
  if (requested && requested.length > MAX_CHAINS_PER_REQUEST) {
    throw new HttpError(
      400,
      "too-many-chains",
      `at most ${MAX_CHAINS_PER_REQUEST} chainIds per request`,
    );
  }
  const chainIds = requested;

  const result = await approvalsScan({ owner, chainIds }, {});
  return {
    status: 200,
    body: {
      ok: true,
      owner: result.owner,
      scannedRange: result.scannedRange,
      approvals: result.approvals,
      scans: result.scans,
      warnings: result.warnings,
    },
  };
}

/**
 * Accept either a bare EVM address string or the multi-family object the app
 * sends ({ evm, solana, bitcoin, hyperliquid }). Returns null when no usable
 * EVM address is present; callers reject rather than fall back to the env.
 */
const PUBLIC_SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBLIC_BTC_RE = /^([13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[ac-hj-np-z02-9]{11,71})$/i;

// Optional side-addresses. Invalid input returns null rather than throwing:
// a malformed BTC address must not deny someone their EVM balances.
function optionalSolanaAddress(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return PUBLIC_SOL_RE.test(v) ? v : null;
}

function optionalBitcoinAddress(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return PUBLIC_BTC_RE.test(v) ? v : null;
}

function ownerEvmAddress(value) {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const evm = value.evm;
    if (typeof evm === "string" && evm.trim() !== "") return evm;
  }
  return null;
}

/**
 * Portfolio balances for a caller-supplied owner.
 *
 * The owner is REQUIRED and never falls back to the environment. The provider
 * resolves ORACLE_EVM_ADDRESS and friends when no address is passed, which on
 * an anonymous public plane would answer a stranger's request with the
 * operator's own wallet. Reject instead.
 *
 * EVM JSON-RPC cannot enumerate wallet tokens without an address indexer, so
 * this returns native balances and reports token/NFT discovery as unavailable
 * per chain rather than presenting an empty list as a complete portfolio.
 */
async function handlePortfolio(body) {
  const b = asPlainObject(body, "body");
  const owner = ownerEvmAddress(b.owner);
  // The provider has supported Solana and Bitcoin all along, but this handler
  // hardcoded { evm: owner }, so a SOL/BTC wallet could never return a balance
  // no matter what the caller sent.
  const solana = optionalSolanaAddress(b.solana);
  const bitcoin = optionalBitcoinAddress(b.bitcoin);
  if (!owner && !solana && !bitcoin) {
    throw new HttpError(400, "owner-required", "owner must be an EVM address (or pass solana/bitcoin)");
  }
  const requested = Array.isArray(b.chainIds) ? b.chainIds.map(Number).filter(Number.isFinite) : undefined;
  if (requested && requested.length > MAX_CHAINS_PER_REQUEST) {
    throw new HttpError(400, "too-many-chains", `at most ${MAX_CHAINS_PER_REQUEST} chainIds per request`);
  }

  const result = await portfolioBalance(
    {
      addresses: { evm: owner, solana, bitcoin },
      evmChainIds: requested,
      includePrices: true,
      includeTokens: true,
      includeCollectibles: false,
    },
    // Empty env: the provider must not read operator addresses from process.env
    // on a public request.
    { env: {} },
  );

  const rows = [];
  const chains = [];
  for (const chain of result.chains || []) {
    // Non-EVM families carry the same native/status shape; skipping them here
    // is what made SOL/BTC invisible even when the provider resolved them.
    if (!["evm", "solana", "bitcoin"].includes(chain.family)) continue;
    chains.push({
      chainId: chain.chainId,
      // Without family the app cannot tell a Solana row from an EVM row: both
      // carry a chainId and a symbol.
      family: chain.family,
      name: chain.name,
      status: chain.status,
      error: chain.error ?? null,
      tokenDiscovery: chain.fungibleTokens?.status ?? "unavailable",
      tokenDiscoveryReason: chain.fungibleTokens?.reason ?? null,
    });
    const native = chain.native;
    if (chain.status !== "ok" || !native || native.status !== "ok") continue;
    if (!native.amountRaw || native.amountRaw === "0" || native.amountRaw === "0x0") continue;
    rows.push({
      chainId: chain.chainId,
      family: chain.family,
      chain: chain.name,
      symbol: native.symbol,
      decimals: native.decimals,
      // `amount` MUST be the raw integer. The app's pricing path runs
      // decimalAmount(row.amount, row.decimals), which requires /^\d+$/ and
      // returns null for a human-readable "6.632...". A null there silently
      // drops the row from every USD total.
      amount: String(native.amountRaw),
      amountRaw: String(native.amountRaw),
      amountFormatted: native.amount,
      kind: "native",
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      owner: result.addresses?.evm ?? owner,
      queriedAt: result.queriedAt,
      // Nested under `portfolio` because that is the shape the app's data-plane
      // client already parses (rawRows reads value.portfolio.rows).
      portfolio: {
        rows,
        chains,
        coverage: result.coverage,
        // Native-only discovery is a real gap, not a complete picture. Surfaced
        // so the client renders it instead of implying the wallet is empty.
        complete: false,
        incompleteReason:
          "EVM JSON-RPC returns native balances only; token enumeration requires an address indexer",
      },
      warnings: result.warnings,
    },
  };
}

/**
 * NFT inventory for a caller-supplied owner. Same owner rule as portfolio.
 */
async function handleNfts(body) {
  const b = asPlainObject(body, "body");
  const owner = ownerEvmAddress(b.owner);
  if (!owner) throw new HttpError(400, "owner-required", "owner must be an EVM address");

  const result = await nftInventory({ addresses: { evm: owner } }, { env: {} });
  return {
    status: 200,
    body: {
      ok: true,
      owner,
      queriedAt: result.queriedAt ?? new Date().toISOString(),
      // Nested to match the shape the app's client parses: value.nfts.items
      // plus value.nfts.coverage.
      nfts: {
        items: Array.isArray(result.items) ? result.items : [],
        chains: result.chains ?? [],
        coverage: {
          operational: result.ok !== false,
          complete: result.complete === true,
          hasGaps: result.complete !== true,
        },
      },
      warnings: result.warnings,
    },
  };
}

/** Direct handler access for tests. Not routed; no auth implications. */
export const handlePortfolioForTest = handlePortfolio;
export const handleNftsForTest = handleNfts;

/**
 * Per-IP rate limiting for the unauthenticated public plane.
 *
 * `/public/approvals` fans a single request out to many upstream RPC calls, so
 * an unthrottled loop against it burns the shared public-RPC quota and the
 * service's own capacity. Cheap reads (health, config) get a loose ceiling;
 * anything that amplifies into upstream work gets a strict one.
 *
 * Fixed-window counters in memory: no dependency, no shared state, and a
 * restart simply forgives. Sufficient for accidental hammering and casual
 * abuse; a real edge/WAF is still the answer for a distributed flood.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_DEFAULT = 120;
/** Routes whose cost is measured in upstream RPC calls, not CPU. */
const RATE_LIMIT_AMPLIFYING = 10;
const AMPLIFYING_ROUTES = Object.freeze(
  new Set(["/public/approvals", "/public/portfolio", "/public/nfts"]),
);
const MAX_RATE_ENTRIES = 4096;

const rateBuckets = new Map();

/** Drop all rate-limit state. Exported for tests. */
export function clearRateLimits() {
  rateBuckets.clear();
}

/**
 * Identify the caller.
 *
 * Proxy headers are honoured ONLY when the operator opts in via
 * ORACLE_TRUST_PROXY, because a spoofable X-Forwarded-For would otherwise let
 * any client mint a fresh identity per request and bypass the limit entirely.
 */
function clientKey(req) {
  if (process.env.ORACLE_TRUST_PROXY === "1") {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      const first = forwarded.split(",")[0].trim();
      if (first) return first.slice(0, 64);
    }
  }
  return req.socket?.remoteAddress || "unknown";
}

function rateLimit(req, routePath) {
  const limit = AMPLIFYING_ROUTES.has(routePath) ? RATE_LIMIT_AMPLIFYING : RATE_LIMIT_DEFAULT;
  const now = Date.now();
  const key = `${clientKey(req)}:${AMPLIFYING_ROUTES.has(routePath) ? "amp" : "std"}`;

  const entry = rateBuckets.get(key);
  if (!entry || now >= entry.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    while (rateBuckets.size > MAX_RATE_ENTRIES) {
      const oldest = rateBuckets.keys().next();
      if (oldest.done) break;
      rateBuckets.delete(oldest.value);
    }
    return { allowed: true, limit, remaining: limit - 1, retryAfterSec: 0 };
  }

  entry.count += 1;
  if (entry.count > limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, limit, remaining: limit - entry.count, retryAfterSec: 0 };
}

const ROUTES = Object.freeze({
  "GET /public/health": handleHealth,
  "GET /public/config": handleConfig,
  "POST /public/connect/request": handleConnectRequest,
  "POST /public/connect/assemble": handleConnectAssemble,
  "POST /public/grants/active": handleGrantsActive,
  "POST /public/grants/get": handleGrantsGet,
  "POST /public/approvals": handleApprovals,
  "POST /public/portfolio": handlePortfolio,
  "POST /public/nfts": handleNfts,
});

function publicHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "x-oracle-plane": PUBLIC_PLANE,
    "x-oracle-unsigned": "true",
    ...extra,
  };
}

function sendStatic(res, status, contentType, body) {
  res.writeHead(status, publicHeaders({ "content-type": contentType }));
  res.end(body);
}

/**
 * Serve allowlisted Oracle console assets only.
 * Returns true if the request was handled (including 404 for missing file).
 */
function tryServeStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  // Keep trailing slash variants resolvable via STATIC_FILES keys.
  const rawPath = pathname === "" ? "/" : pathname;
  const meta = STATIC_FILES[rawPath] || STATIC_FILES[rawPath.replace(/\/+$/, "") || "/"];
  if (!meta) return false;

  const abs = normalize(join(CONSOLE_DIR, meta.file));
  if (!abs.startsWith(CONSOLE_DIR + sep) && abs !== CONSOLE_DIR) {
    send(res, 404, { error: "not-found", message: "unknown static path" });
    return true;
  }
  if (!existsSync(abs)) {
    send(res, 404, { error: "not-found", message: `missing static file ${meta.file}` });
    return true;
  }
  const body = readFileSync(abs);
  // Static HTML/JS/CSS are not JSON secret-scanned the same way as API bodies;
  // content is repo-authored allowlisted files only.
  if (req.method === "HEAD") {
    res.writeHead(200, publicHeaders({
      "content-type": meta.type,
      "content-length": String(body.length),
    }));
    res.end();
    return true;
  }
  sendStatic(res, 200, meta.type, body);
  return true;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  // Preserve a single trailing slash only for static console aliases.
  let pathname = url.pathname || "/";
  if (pathname.length > 1 && pathname.endsWith("/") && pathname !== "/oracle-console/") {
    pathname = pathname.replace(/\/+$/, "");
  }
  if (pathname === "") pathname = "/";
  const routePath = pathname.replace(/\/+$/, "") || "/";
  const key = `${req.method} ${routePath}`;
  const handler = ROUTES[key];

  try {
    if (!handler) {
      if (tryServeStatic(req, res, pathname)) return;
      const pathKnown = Object.keys(ROUTES).some((k) => k.endsWith(` ${routePath}`));
      if (pathKnown) throw new HttpError(405, "method-not-allowed", `unsupported method for ${routePath}`);
      throw new HttpError(404, "not-found", `unknown route ${routePath}`);
    }
    const gate = rateLimit(req, routePath);
    if (!gate.allowed) {
      res.writeHead(429, publicHeaders({
        "content-type": "application/json",
        "retry-after": String(gate.retryAfterSec),
        "x-ratelimit-limit": String(gate.limit),
        "x-ratelimit-remaining": "0",
      }));
      res.end(JSON.stringify({
        error: "rate-limited",
        message: `too many requests for ${routePath}; retry in ${gate.retryAfterSec}s`,
      }));
      return;
    }

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readJsonBody(req);
    // Handlers may be sync or async; await normalizes both so a rejected
    // promise lands in this try/catch instead of escaping as an unhandled
    // rejection with the socket left open.
    const out = await handler(body);
    send(res, out.status, out.body);
  } catch (err) {
    if (err instanceof SecretLeakError) {
      // Never echo the leak path/rule detail either — fixed envelope only.
      send(res, 500, { error: "secret-leak-blocked" });
      return;
    }
    if (err instanceof GrantValidationError) {
      send(res, 400, {
        error: "invalid-grant",
        errors: err.errors.map((e) => ({ field: e.field, message: e.message })),
      });
      return;
    }
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.code, message: err.message });
      return;
    }
    if (err instanceof TypeError) {
      send(res, 400, { error: "bad-request", message: err.message });
      return;
    }
    // Unknown failure: fixed envelope, no internal detail leaves the server.
    send(res, 500, { error: "internal-error" });
  }
}

/** Build (but do not bind) the public HTTP server. */
export function createPublicServer() {
  return createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      try {
        send(res, 500, { error: "internal-error" });
      } catch {
        /* socket already gone */
      }
    });
  });
}

/**
 * Resolve host/port: explicit args > ORACLE_PUBLIC_HOST/PORT env (via
 * oracle-env's env() helper) > loopback 127.0.0.1:8799 default.
 * Non-loopback binds fail closed; this plane has no remote peer/origin guard.
 */
export function resolvePublicBind({ host, port } = {}) {
  const h = assertLoopbackBindHost(host ?? env("ORACLE_PUBLIC_HOST", "MAD_PUBLIC_HOST", DEFAULT_HOST));
  const rawPort = port ?? env("ORACLE_PUBLIC_PORT", "MAD_PUBLIC_PORT", String(DEFAULT_PORT));
  const p = Number(rawPort);
  if (!Number.isInteger(p) || p < 0 || p > 65535) {
    throw new TypeError(`invalid public port: ${String(rawPort)}`);
  }
  return { host: h, port: p };
}

/** Create + bind the public server. Returns the node:http server instance. */
export function startPublicServer(bind = {}) {
  const { host, port } = resolvePublicBind(bind);
  const server = createPublicServer();
  server.listen(port, host);
  return server;
}
