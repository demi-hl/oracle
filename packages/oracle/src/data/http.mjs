// Tiny HTTP helpers for the read-only data plane. No signing. No secrets logged.
//
// Optimizations that matter for a self-hoster hitting public rate limits:
//   - bounded retry with Retry-After support on 429 / 502 / 503 / 504
//   - single-flight dedupe so N concurrent identical GETs cost ONE upstream call
//   - both are opt-out via opts.retries = 0 / opts.dedupe = false
//
// SECURITY: the dedupe key binds the FULL credential (hashed), not merely whether
// one was present. Keying on presence alone lets two callers with different API
// keys collapse into one upstream request, so the second caller receives data
// fetched with the first caller's credential. Found in pre-public red team.

import { createHash } from "node:crypto";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
// Methods safe to replay when the transport failed and we cannot know whether
// the server already applied the request.
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const DEFAULT_RETRIES = 2;
const MAX_BACKOFF_MS = 4_000;

// Headers that identify the CALLER. Two requests may only share a deduped
// in-flight response when every one of these matches exactly.
// Any header that distinguishes one caller's credentials from another's. If a
// credential header is MISSING from this list, two different users' requests
// hash identically and the in-flight dedupe collapses them into one — user B
// receives a response fetched with user A's key. Enumerating providers here is
// fragile, so the matcher below also treats anything key/token/secret-shaped as
// identity-bearing.
const IDENTITY_HEADERS = [
  "authorization",
  "x-api-key",
  "x-tensor-api-key",
  "0x-api-key",
  "api-key",
  "cookie",
  "proxy-authorization",
];

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

function credentialHeaderName(name) {
  const h = String(name || "").toLowerCase();
  return IDENTITY_HEADERS.includes(h) || /(^|-)(api[-_]?key|key|token|secret|auth|authorization|session|cookie|signature|access)(-|$)/.test(h);
}

function stripCredentialHeaders(headers) {
  const safe = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!credentialHeaderName(name)) safe[name] = value;
  }
  return safe;
}

function redirectedUrl(location, currentUrl) {
  if (!location) throw new Error(`HTTP redirect from ${currentUrl} missing Location`);
  const next = new URL(String(location), String(currentUrl));
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new Error(`HTTP redirect from ${currentUrl} used unsupported protocol ${next.protocol}`);
  }
  return next.toString();
}

function sameOrigin(a, b) {
  return new URL(String(a)).origin === new URL(String(b)).origin;
}

const inflight = new Map();

/**
 * Derive a dedupe key that is safe to hold in memory: credential material is
 * hashed, never stored raw, so the cache cannot become a secret-disclosure
 * surface (heap dump, debugger, accidental log of the map).
 */
function dedupeKey(method, url, headers) {
  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) lower[k.toLowerCase()] = v;

  // Structural, not just the known list: ANY header whose name looks like it
  // carries a credential participates in the fingerprint. A fixed enumeration
  // silently fails the moment a provider uses a new header name — that is how
  // `0x-api-key` was omitted, which collapsed two users' 0x requests into one
  // and served user B a response fetched with user A's key.
  const credentialShaped = Object.keys(lower).filter((h) =>
    /(^|-)(api[-_]?key|key|token|secret|auth|authorization|session|cookie|signature|access)(-|$)/.test(h)
  );
  const names = [...new Set([...IDENTITY_HEADERS, ...credentialShaped])].sort();
  const identity = names.map((h) => `${h}=${lower[h] ?? ""}`).join("\n");
  const fingerprint = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `${method} ${url} ${fingerprint}`;
}

function backoffMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  }
  const base = Math.min(250 * 2 ** attempt, MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 100);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(url, { fetchImpl, method, headers, body, timeoutMs }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let currentUrl = String(url);
    let currentHeaders = { ...(headers || {}) };
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const res = await fetchImpl(currentUrl, {
        method,
        headers: currentHeaders,
        body,
        signal: ac.signal,
        redirect: "manual",
      });
      const text = await res.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      if (REDIRECT_STATUS.has(res.status)) {
        if (method !== "GET" && method !== "HEAD") {
          const err = new Error(`HTTP ${res.status} ${method} ${currentUrl} redirected non-idempotent request`);
          err.status = res.status;
          err.body = json ?? text.slice(0, 300);
          throw err;
        }
        if (redirects === MAX_REDIRECTS) throw new Error(`HTTP redirect loop for ${url}`);
        const nextUrl = redirectedUrl(res.headers?.get?.("location"), currentUrl);
        if (!sameOrigin(nextUrl, currentUrl)) currentHeaders = stripCredentialHeaders(currentHeaders);
        currentUrl = nextUrl;
        continue;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${method} ${currentUrl}`);
        err.status = res.status;
        err.retryAfter = res.headers?.get?.("retry-after") ?? null;
        err.body = json ?? text.slice(0, 300);
        throw err;
      }
      return json ?? text;
    }
    throw new Error(`HTTP redirect loop for ${url}`);
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: any, timeoutMs?: number, fetchImpl?: typeof fetch, retries?: number, dedupe?: boolean }} [opts]
 */
export async function httpJson(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch unavailable — pass opts.fetchImpl");
  }
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const method = (opts.method || "GET").toUpperCase();
  const headers = { Accept: "application/json", ...(opts.headers || {}) };
  let body = opts.body;
  if (body != null && typeof body !== "string") {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    body = JSON.stringify(body);
  }
  const retries = Number.isInteger(opts.retries) ? Math.max(opts.retries, 0) : DEFAULT_RETRIES;

  const attempt = async () => {
    let lastError;
    for (let i = 0; i <= retries; i++) {
      try {
        return await once(url, { fetchImpl, method, headers, body, timeoutMs });
      } catch (error) {
        lastError = error;
        const status = error?.status;
        const abortLike = error?.name === "AbortError";
        // A response with a status means the SERVER answered and refused to
        // process the request, so replaying it is safe. A transport-level
        // failure (no status) is ambiguous: the server may have already applied
        // the request and only the response was lost. Never replay a
        // non-idempotent method on an ambiguous failure.
        // A retryable STATUS is not on its own a licence to replay: a 500 or
        // 503 can be returned after the server already applied the request, so
        // replaying a POST can place a second order or submit a second
        // transaction. 429/408/425 mean "not processed", so those stay
        // retryable for every method; genuine server errors only replay for
        // idempotent methods.
        const ALWAYS_SAFE_STATUS = new Set([408, 425, 429]);
        const retryable =
          status != null
            ? ALWAYS_SAFE_STATUS.has(status) ||
              (RETRYABLE_STATUS.has(status) && IDEMPOTENT_METHODS.has(method))
            : !abortLike && IDEMPOTENT_METHODS.has(method);
        if (i === retries || !retryable) throw error;
        await sleep(backoffMs(i, error?.retryAfter));
      }
    }
    throw lastError;
  };

  // Single-flight only for idempotent GETs with no body.
  const dedupe = opts.dedupe !== false && method === "GET" && body == null;
  if (!dedupe) return attempt();

  const key = dedupeKey(method, url, headers);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = attempt().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export async function timed(fn) {
  const t0 = Date.now();
  try {
    const data = await fn();
    return { ok: true, ms: Date.now() - t0, data };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: String(e.message || e),
      status: e.status ?? null,
    };
  }
}

/**
 * Run async tasks with a hard concurrency ceiling. Public health sweeps fan out
 * across ~30 providers; unbounded Promise.all trips public rate limits.
 */
export async function mapLimit(items, limit, fn) {
  const list = Array.from(items);
  const cap = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const out = new Array(list.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: cap }, async () => {
      while (cursor < list.length) {
        const index = cursor++;
        out[index] = await fn(list[index], index);
      }
    })
  );
  return out;
}
