// File-backed scoped API keys for multi-user onboarding.
// NON-CUSTODIAL: we store only a HASH of the API key + owner wallet address.
// We never store the user's private key. agent:execute requires controller allowlist.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeScopes, EXECUTE_SCOPE, DEFAULT_SCOPES } from "../scopes.mjs";

// API keys are 32+ bytes of CSPRNG output, not user-chosen passwords. SHA-256
// is the right lookup hash here (same class as GitHub PATs). Slow password
// KDFs would only add DoS surface on every authenticated request.
// codeql[js/insufficient-password-hash]
function hashKey(raw) {
  return createHash("sha256").update(String(raw), "utf8").digest("hex");
}

function emptyState() {
  return { version: 1, keys: [] };
}

export function defaultStorePath() {
  if (process.env.ORACLE_AGENT_KEYS_PATH) return process.env.ORACLE_AGENT_KEYS_PATH;
  if (process.env.MAD_AGENT_KEYS_PATH) return process.env.MAD_AGENT_KEYS_PATH;
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return join(root, "data", "agent-keys.json");
}

function readState(path) {
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || !Array.isArray(parsed.keys)) return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function publicRecord(rec) {
  return {
    id: rec.id,
    owner: rec.owner,
    name: rec.name,
    scopes: rec.scopes,
    tier: rec.tier || null,
    createdAt: rec.createdAt,
    revokedAt: rec.revokedAt || null,
    lastUsedAt: rec.lastUsedAt || null,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.owner  user wallet address (checksum optional)
 * @param {string} [opts.name]
 * @param {string[]} [opts.scopes]
 * @param {string} [opts.tier]
 * @param {string[]} [opts.controllerAllowlist] required if scopes include agent:execute
 * @param {string} [opts.storePath]
 * @returns {{ key: string, record: object }}  raw key shown ONCE
 */
export function createAgentKey({
  owner,
  name = "Agent key",
  scopes,
  tier = null,
  controllerAllowlist = [],
  storePath = defaultStorePath(),
} = {}) {
  const normalizedOwner = String(owner || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalizedOwner)) {
    throw new Error("owner must be a 0x-prefixed 20-byte address");
  }
  const normalizedScopes = normalizeScopes(scopes);
  if (normalizedScopes.includes(EXECUTE_SCOPE)) {
    const rawList = controllerAllowlist.length
      ? controllerAllowlist
      : String(process.env.MAD_EXECUTOR_CONTROLLERS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    const allow = new Set(rawList.map((a) => String(a).toLowerCase()));
    if (!allow.has(normalizedOwner)) {
      throw new Error("Wallet is not an executor controller");
    }
  }

  const raw = `mad_${randomBytes(24).toString("base64url")}`;
  const rec = {
    id: randomBytes(8).toString("hex"),
    owner: normalizedOwner,
    name: String(name).slice(0, 80),
    scopes: normalizedScopes,
    tier,
    keyHash: hashKey(raw),
    createdAt: new Date().toISOString(),
    revokedAt: null,
    lastUsedAt: null,
  };

  const state = readState(storePath);
  state.keys.push(rec);
  writeState(storePath, state);

  return { key: raw, record: publicRecord(rec) };
}

export function listAgentKeys(owner, { storePath = defaultStorePath(), includeRevoked = false } = {}) {
  const o = String(owner || "").toLowerCase();
  const state = readState(storePath);
  return state.keys
    .filter((k) => k.owner === o)
    .filter((k) => includeRevoked || !k.revokedAt)
    .map(publicRecord);
}

export function revokeAgentKey({ owner, id, storePath = defaultStorePath() } = {}) {
  const o = String(owner || "").toLowerCase();
  const state = readState(storePath);
  const rec = state.keys.find((k) => k.owner === o && k.id === id);
  if (!rec) throw new Error("key not found");
  if (rec.revokedAt) return publicRecord(rec);
  rec.revokedAt = new Date().toISOString();
  writeState(storePath, state);
  return publicRecord(rec);
}

/**
 * Authenticate a raw API key. Returns public record + owner-bound identity
 * suitable for getSigner({ identity: { type: 'scoped-key', ... } }).
 */
export function authenticateAgentKey(rawKey, { storePath = defaultStorePath() } = {}) {
  if (!rawKey) throw new Error("key required");
  const h = hashKey(rawKey);
  const state = readState(storePath);
  const rec = state.keys.find((k) => k.keyHash === h && !k.revokedAt);
  if (!rec) throw new Error("invalid or revoked key");
  rec.lastUsedAt = new Date().toISOString();
  writeState(storePath, state);
  return {
    ...publicRecord(rec),
    identity: {
      type: "scoped-key",
      owner: rec.owner,
      scopes: rec.scopes,
    },
  };
}

export function __resetAgentKeysForTest(storePath) {
  writeState(storePath || defaultStorePath(), emptyState());
}

export { DEFAULT_SCOPES, EXECUTE_SCOPE };
