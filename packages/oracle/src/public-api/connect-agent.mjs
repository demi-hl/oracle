// Oracle Public API — connect-agent contract (Slice D).
//
// BFF-safe, self-custodial contract that turns a user's "connect my agent"
// request into an UNSIGNED grant payload the USER signs with their own wallet.
//
// Hard boundaries for this file:
//   - NEVER signs anything. There is no signer, no key material, no signature
//     field ever populated here. The output hands back the exact bytes the
//     user must sign themselves; signing happens client-side in the user's
//     own wallet, never on a server.
//   - Imports ONLY from the assigned public peers
//     (src/public-control/policy-schema.mjs, session-key-model.mjs).
//     Never from the private executor stack (get-signer, keystore,
//     exec-policy, local-signer/*, adapters/*).
//   - Oracle Control is deterministic authorization: same input => same
//     canonical bytes => same grant id. No advisory logic here (that is
//     Oracle Router's job and Router output never gates anything here).
//   - Fail-closed no-secret invariant: every object returned from this module
//     is recursively scanned and the call THROWS if anything shaped like a
//     private key, session secret, bearer token, keystore path, or signer URL
//     is present. See assertNoSecretMaterial().

import {
  GRANT_VERSION,
  GrantValidationError,
  normalizeGrant,
  canonicalizeGrant,
  grantId,
  isReadonlyAction,
} from "../public-control/policy-schema.mjs";

export const CONNECT_REQUEST_KIND = "oracle-connect-request";
export const UNSIGNED_GRANT_KIND = "oracle-unsigned-grant";

/** Identifier for how the signable bytes are derived: utf-8 encoding of the
 *  canonical grant JSON produced by policy-schema's canonicalizeGrant(). */
export const SIGNING_SCHEME = "oracle-grant-canonical-json-utf8-v1";

// ---------------------------------------------------------------------------
// No-secret invariant (fail closed)
// ---------------------------------------------------------------------------

export class SecretLeakError extends Error {
  constructor(path, rule) {
    super(`secret material must never appear in a public API object (at ${path}, rule: ${rule})`);
    this.name = "SecretLeakError";
    this.path = path;
    this.rule = rule;
  }
}

/** Key names that must never appear on any object we return. */
const FORBIDDEN_KEY_RE =
  /(private[_-]?key|secret|bearer|keystore|mnemonic|seed[_-]?phrase|passphrase|password|api[_-]?key|access[_-]?token|auth[_-]?token|session[_-]?token|signer[_-]?url|signature)/i;

/** Short wallet-export aliases need exact normalized matching. Substring
 * matching `wif`, for example, would incorrectly reject an unrelated key such
 * as `swift`. Removing common separators catches snake/kebab/spaced variants
 * without widening those short aliases into arbitrary words. */
const FORBIDDEN_KEY_ALIASES = Object.freeze(["privkey", "wif", "xprv", "seed"]);

function isForbiddenKeyName(key) {
  const text = String(key);
  const normalized = text.toLowerCase().replace(/[\s._-]+/g, "");
  return FORBIDDEN_KEY_RE.test(text) || FORBIDDEN_KEY_ALIASES.includes(normalized);
}

/** String-value shapes that must never appear in any object we return. */
const FORBIDDEN_VALUE_RULES = Object.freeze([
  // 32-byte hex — the shape of a raw EVM private key / session secret. Public
  // grant material never legitimately carries a 0x + 64-hex value (addresses
  // are 40 hex; the grant id is bare sha256 hex), so this fails closed.
  { rule: "raw-32-byte-hex-key", re: /^0x[0-9a-fA-F]{64}$/ },
  // Same 32 bytes WITHOUT the 0x prefix, as the entire string. A bare-hex
  // private key (the shape ethers and most wallet exports hand you) must not
  // pass just because it lacks the prefix.
  //
  // Deliberately anchored: an embedded/substring match would flag legitimate
  // prose that quotes a public sha256 identifier (the human-readable grant
  // render says "grant <id>"), and a scanner that cries wolf on normal output
  // gets disabled. Smuggling a key inside a longer string is still caught at
  // the serialized layer for any non-allowlisted field.
  { rule: "raw-32-byte-hex-bare", re: /^[0-9a-fA-F]{64}$/ },
  // BIP-32 private extended keys. Public xpub/tpub/ypub/zpub identifiers are
  // intentionally not matched; only their private-key counterparts fail.
  { rule: "extended-private-key", re: /\b(?:xprv|tprv|yprv|zprv)[1-9A-HJ-NP-Za-km-z]{107}\b/ },
  // Bitcoin WIF (mainnet 5/K/L, testnet uncompressed 9 or compressed c) —
  // base58, 51-52 chars.
  { rule: "bitcoin-wif", re: /\b[59KLc][1-9A-HJ-NP-Za-km-z]{50,51}\b/ },
  // BIP-39 mnemonic: 12/15/18/21/24 lowercase words. Detect a long run of
  // space-separated short alpha words rather than shipping the wordlist.
  { rule: "bip39-mnemonic", re: /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/ },
  { rule: "bearer-token", re: /bearer\s+[A-Za-z0-9._~+/=-]+/i },
  { rule: "pem-private-key", re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { rule: "keystore-path", re: /keystore/i },
  { rule: "signer-url", re: /https?:\/\/\S*sign/i },
  { rule: "authorization-header", re: /authorization\s*:/i },
]);

/**
 * Field names whose values are legitimately 64-hex and are NOT secrets:
 * sha256 grant ids, tx hashes, block hashes, canonical digests. These are
 * public identifiers — the whole point of a grant id is that it is quotable.
 *
 * Deliberately EXCLUDED: `nonce` and `salt`. Those are caller-supplied on the
 * public path, so allowlisting them would let anyone launder key material
 * through the scan just by naming the field `nonce`. Oracle's own nonces are
 * short opaque strings, not 32-byte hex, so nothing legitimate is lost.
 */
const HEX64_ALLOWED_KEYS = Object.freeze([
  "grantid",
  "id",
  "hash",
  "sha256",
  "sha256hex",
  "checksum",
  "txhash",
  "transactionhash",
  "blockhash",
  "digest",
  "userophash",
  "commithash",
  "prevhash",
  "intenthash",
  "canonicalhash",
  "payloadhash",
  "requestid",
]);

/**
 * Strip values that are legitimately 64-hex public identifiers before running
 * the raw-key shape rules, so a sha256 grant id does not read as a private key.
 * Only exact-match 64-hex values on an allowlisted key are removed; a 64-hex
 * string sitting anywhere else still trips the rule.
 */
function maskAllowedHex64(json) {
  return json.replace(
    /"([A-Za-z0-9_-]+)"\s*:\s*"(?:0x)?([0-9a-fA-F]{64})"/g,
    (match, key) =>
      HEX64_ALLOWED_KEYS.includes(String(key).toLowerCase().replace(/[_-]/g, ""))
        ? `"${key}":"<hex64>"`
        : match
  );
}
/**
 * Scan the SERIALIZED form of a payload.
 *
 * Scanning the object graph alone is not sufficient: `toJSON()`, getters,
 * symbol keys, non-enumerable properties and BigInt coercion all let a value
 * reach the wire in a shape the graph walk never visited. Verified: an object
 * `{ nested: { toJSON: () => "<private key>" } }` passes a graph-only scan and
 * then serializes the raw key into the response body.
 *
 * So the authoritative check runs against the exact bytes we are about to
 * write. Whatever JSON.stringify produces is what the client sees, and that is
 * what we scan. Returns the JSON string when clean; throws SecretLeakError
 * otherwise.
 */
export function assertSerializedNoSecrets(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (e) {
    // A payload we cannot serialize (circular, BigInt, throwing toJSON) must
    // not be sent at all — fail closed rather than guess.
    throw new SecretLeakError("$", `unserializable-payload: ${String(e?.message || e)}`);
  }
  if (json === undefined) return "null";

  // Public 64-hex identifiers (grant ids, tx/block hashes, sha256 digests) are
  // masked first so they do not read as raw key material.
  const scanned = maskAllowedHex64(json);

  for (const { rule, re } of FORBIDDEN_VALUE_RULES) {
    if (re.test(scanned)) throw new SecretLeakError("$<serialized>", rule);
  }

  // Embedded key material. The per-string rules are anchored (so human-readable
  // prose quoting a public grant id does not trip them), but at the serialized
  // layer a 0x-prefixed 32-byte value has no legitimate reason to appear
  // anywhere in a public response — addresses are 40 hex, and every public
  // 64-hex identifier was masked above. This is what catches a key smuggled in
  // via toJSON(), a getter, or concatenated into a longer string.
  const embedded = /(?:^|[^0-9a-fA-Fx])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
  if (embedded.test(scanned)) {
    throw new SecretLeakError("$<serialized>", "raw-32-byte-hex-embedded");
  }
  // Parse the exact serialized bytes with a reviver so escaped or toJSON-made
  // key names receive the same normalization as real object properties. This
  // avoids maintaining a second, inevitably drifting key-name regex.
  JSON.parse(json, (key, item) => {
    if (key && isForbiddenKeyName(key)) {
      throw new SecretLeakError(`$<serialized>.${key}`, "forbidden-key-name");
    }
    return item;
  });
  return json;
}

/**
 * Recursively scan a value (objects, arrays, Maps, Sets, typed arrays) for
 * anything shaped like secret material. Throws SecretLeakError on the first
 * hit — fail closed. Returns the value unchanged when clean, so it can be
 * used inline: `return assertNoSecretMaterial(result)`.
 *
 * `keyHint` carries the property name a string was found under, so a 64-hex
 * value on a known public identifier (grantId, txHash, ...) is not mistaken
 * for raw key material. A 64-hex string under any other key still trips.
 */
export function assertNoSecretMaterial(value, path = "$", seen = new Set(), keyHint = "") {
  if (value == null) return value;
  if (typeof value === "string") {
    const hex64Ok = HEX64_ALLOWED_KEYS.includes(
      String(keyHint).toLowerCase().replace(/[_-]/g, "")
    );
    for (const { rule, re } of FORBIDDEN_VALUE_RULES) {
      if (hex64Ok && rule.startsWith("raw-32-byte-hex")) continue;
      if (re.test(value)) throw new SecretLeakError(path, rule);
    }
    return value;
  }
  if (typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (value instanceof Map) {
    for (const [k, v] of value.entries()) {
      if (typeof k === "string" && isForbiddenKeyName(k)) {
        throw new SecretLeakError(`${path}[${JSON.stringify(k)}]`, "forbidden-key-name");
      }
      assertNoSecretMaterial(k, `${path}[key]`, seen);
      assertNoSecretMaterial(v, `${path}[${String(k)}]`, seen);
    }
    return value;
  }
  if (value instanceof Set) {
    let i = 0;
    for (const v of value.values()) assertNoSecretMaterial(v, `${path}[${i++}]`, seen);
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretMaterial(v, `${path}[${i}]`, seen));
    return value;
  }
  for (const [k, v] of Object.entries(value)) {
    if (isForbiddenKeyName(k)) {
      throw new SecretLeakError(`${path}.${k}`, "forbidden-key-name");
    }
    assertNoSecretMaterial(v, `${path}.${k}`, seen, k);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function toUnixSeconds(v, label) {
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new GrantValidationError([{ field: label, message: "must be a positive unix-seconds integer" }]);
  }
  return n;
}

function requiredReferenceNow(opts) {
  if (opts?.now == null) {
    throw new GrantValidationError([
      { field: "opts.now", message: "explicit reference time is required for live grant construction" },
    ]);
  }
  return toUnixSeconds(opts.now, "opts.now");
}

/** Deterministic UTC ISO string from unix seconds. */
function isoUtc(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

/** Deterministic, purely-presentational human render of a normalized grant.
 *  Presentation only — it never adds, removes, or reinterprets authority and
 *  only surfaces public grant material. */
function renderUnsignedGrant(grant, id) {
  const readonlyOnly = grant.actions.every((a) => isReadonlyAction(a));
  return [
    "ORACLE — CONNECT AGENT (unsigned grant, you sign it, we never do)",
    "=================================================================",
    `Grant ID:      ${id}`,
    `Version:       ${GRANT_VERSION}`,
    `Chain:         ${grant.chainId}`,
    `Agent:         ${grant.agentAddress}`,
    `Your account:  ${grant.accountAddress}`,
    `Actions:       ${grant.actions.join(", ")}`,
    `Targets:       ${grant.targets.length ? grant.targets.join(", ") : "(none — read/simulate only)"}`,
    `Max value:     ${grant.maxValueWei} wei`,
    `Max gas:       ${grant.maxGasWei} wei`,
    `Max slippage:  ${grant.maxSlippageBps} bps`,
    `Expires:       ${isoUtc(grant.expiresAt)} (unix ${grant.expiresAt})`,
    `Nonce:         ${grant.nonce}`,
    `Revocation:    ${grant.revocationKey}`,
    "-----------------------------------------------------------------",
    readonlyOnly
      ? "Scope: read/simulate only — this grant cannot move funds."
      : "Scope: includes state-changing actions bounded by the caps above.",
    "Self-custodial: this payload is UNSIGNED and contains public data only.",
    "Sign the bytes below with YOUR wallet; Oracle never holds your keys.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Turn raw user inputs into a validated connect request.
 *
 * Accepts the canonical grant fields (see policy-schema REQUIRED_FIELDS).
 * Every live construction requires explicit `opts.now` (unix seconds).
 * Convenience: instead of `expiresAt` the caller may pass `ttlSeconds`.
 * Determinism requires the library caller to supply `now`; the HTTP boundary
 * overwrites caller time with the server clock.
 *
 * Throws GrantValidationError on any invalid/unknown/missing field (the
 * schema fails closed on unknown fields, wildcard actions, empty targets for
 * state-changing scopes, etc). Never signs anything.
 *
 * @returns frozen { kind, version, grant } where grant is the normalized
 *          canonical grant from policy-schema.
 */
export function buildConnectRequest(input = {}, opts = {}) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new GrantValidationError([{ field: "request", message: "request must be a plain object" }]);
  }
  const now = requiredReferenceNow(opts);

  const { ttlSeconds, ...rest } = input;
  const fields = { ...rest };

  if (ttlSeconds != null) {
    if (fields.expiresAt != null) {
      throw new GrantValidationError([
        { field: "ttlSeconds", message: "pass either ttlSeconds or expiresAt, not both" },
      ]);
    }
    const ttl = toUnixSeconds(ttlSeconds, "ttlSeconds");
    fields.expiresAt = now + ttl;
  }

  const grant = normalizeGrant(fields, {
    now,
    allowWildcardActions: opts.allowWildcardActions === true,
  });

  const request = deepFreeze({
    kind: CONNECT_REQUEST_KIND,
    version: GRANT_VERSION,
    grant,
  });
  return assertNoSecretMaterial(request);
}

/**
 * Assemble the UNSIGNED grant payload for a connect request (or raw grant
 * input). Returns everything a BFF/browser needs to show the user what they
 * are approving and exactly which bytes to sign — and nothing else:
 *
 *   payload   — { version, grantId, grant, canonical } canonical grant data
 *   signing   — { scheme, message, bytesHex, byteLength, sha256 } where
 *               `message` is the exact canonical JSON string and `bytesHex`
 *               is the 0x-hex of its utf-8 bytes: THE bytes the user signs.
 *   render    — deterministic human-readable review text
 *   unsigned  — always true; this module never signs and never will.
 *
 * Deterministic: identical grants (any key order / address casing / numeric
 * representation) produce byte-identical canonical/message/bytesHex/grantId.
 *
 * Fail-closed: requires explicit `opts.now`, throws GrantValidationError on bad
 * input, and throws SecretLeakError if the assembled object ever carried
 * secret-shaped material.
 */
export function assembleUnsignedGrant(requestOrInput = {}, opts = {}) {
  const now = requiredReferenceNow(opts);
  const raw =
    requestOrInput && requestOrInput.kind === CONNECT_REQUEST_KIND
      ? requestOrInput.grant
      : requestOrInput;

  const grant = normalizeGrant(raw, {
    now,
    allowWildcardActions: opts.allowWildcardActions === true,
  });
  const canonical = canonicalizeGrant(grant);
  const id = grantId(grant);
  const bytes = Buffer.from(canonical, "utf8");

  const result = deepFreeze({
    kind: UNSIGNED_GRANT_KIND,
    unsigned: true,
    payload: deepFreeze({
      version: GRANT_VERSION,
      grantId: id,
      grant,
      canonical,
    }),
    signing: deepFreeze({
      scheme: SIGNING_SCHEME,
      message: canonical,
      bytesHex: `0x${bytes.toString("hex")}`,
      byteLength: bytes.length,
      sha256: id,
    }),
    render: renderUnsignedGrant(grant, id),
  });
  return assertNoSecretMaterial(result);
}
