// Provider endpoint pinning.
//
// Every keyed provider had the same shape: `baseUrl` came from caller-supplied
// opts, and headers() attached the operator's API key unconditionally. One
// hostile opts object — from a prompt-injected model, a malicious skill, or a
// config someone pasted — ships the credential to an arbitrary host. That is
// credential exfiltration and SSRF wearing a configuration costume.
//
// The rule here: a credential is attached ONLY when the resolved host is one
// the provider is pinned to. Overriding the URL is still allowed (local mocks,
// self-hosted proxies, testing) but doing so DROPS the key rather than
// forwarding it somewhere new.

const OVERRIDE_ENV = "ORACLE_ALLOW_CUSTOM_PROVIDER_URL";

/**
 * @param {object} spec
 * @param {string} spec.provider   provider id, for error messages
 * @param {string} spec.defaultUrl the pinned default endpoint
 * @param {string[]} spec.hosts    hostnames allowed to receive the credential
 * @param {string} [spec.url]      caller/env supplied override
 * @param {boolean} [spec.strict]  throw instead of dropping the key
 */
export function resolveProviderEndpoint({ provider, defaultUrl, hosts = [], url, strict = false }) {
  // An empty/blank override means "not configured", not "call the empty
  // string". Treat it as absent so callers can pass `opts.baseUrl` straight
  // through without pre-checking it.
  const override = String(url ?? "").trim();
  const raw = (override || String(defaultUrl)).replace(/\/$/, "");
  if (raw === String(defaultUrl).replace(/\/$/, "")) {
    return { baseUrl: raw, trusted: true, host: hostOf(defaultUrl) };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${provider}: baseUrl must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${provider}: baseUrl must be an absolute http(s) URL`);
  }
  const host = parsed.host;
  if (!host) {
    throw new Error(`${provider}: baseUrl must be an absolute http(s) URL`);
  }

  const allowed = new Set([hostOf(defaultUrl), ...hosts]);
  if (allowed.has(host)) {
    // A protocol downgrade to plaintext would put the pinned credential on the
    // wire in cleartext, so an allowlisted HOST over http:// is still not a
    // trusted destination for a secret. Loopback is exempt: there is no wire.
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
    if (parsed.protocol === "http:" && !loopback) {
      return { baseUrl: raw, trusted: false, host, reason: "plaintext http downgrade" };
    }
    return { baseUrl: raw, trusted: true, host };
  }

  if (String(process.env[OVERRIDE_ENV] || "") === "1") {
    // Explicit operator opt-in. Still untrusted: the caller asked for a
    // different host, so the key does not travel there.
    return { baseUrl: raw, trusted: false, host };
  }

  if (strict) {
    throw new Error(
      `${provider}: refusing to call non-allowlisted host ${host} (set ${OVERRIDE_ENV}=1 to permit it)`
    );
  }
  return { baseUrl: raw, trusted: false, host };
}

function hostOf(url) {
  const u = new URL(String(url));
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("unsupported protocol");
  return u.host;
}

/**
 * Attach credential headers only to a trusted endpoint.
 *
 * @param {object} baseHeaders  headers safe for any host (accept, user-agent)
 * @param {object} credentials  header name -> secret value
 * @param {boolean} trusted     from resolveProviderEndpoint
 */
export function credentialedHeaders(baseHeaders, credentials, trusted) {
  const h = { ...baseHeaders };
  if (!trusted) return h;
  for (const [name, value] of Object.entries(credentials || {})) {
    if (value) h[name] = value;
  }
  return h;
}
