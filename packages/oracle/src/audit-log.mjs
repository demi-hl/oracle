// Tamper-evident, append-only audit hash-chain for the Oracle exec layer.
//
// Adapted from block/buzz `buzz-audit` (Rust + Postgres, multi-tenant) to Oracle's
// single-process, file-backed model. Fills the gap the custody review found:
// the armed executor had a rolling daily-spend counter and NO tamper-evident
// record of what it prepared / signed / broadcast. This is the compliance/trust
// spine the non-custodial agency product needs, shared by every oracle-<chain>
// worker that routes through the exec-server.
//
// Each entry chains to the previous via SHA-256 over a FIXED field order that
// includes `prev_hash`, so deleting, editing, or reordering any entry breaks
// verification of every entry after it. `detail` is folded in via canonical
// JSON (recursively sorted keys) so the hash is stable across Arch/VPS/Mac.
//
// SECURITY: `detail` is persisted verbatim and included in the hash. NEVER write
// bearer tokens, private keys, passwords, or keystore passphrases into it. Log
// outcome metadata (chainId, to, value, hash, reason) only.

import { createHash } from "node:crypto";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, env } from "./oracle-env.mjs";

/** 32-byte sentinel (hex) hashed in place of prev_hash for the first entry. */
export const GENESIS_HASH = "0".repeat(64);

/** Actions the exec layer records. Unknown actions are allowed (forward-compat)
 *  but this set documents the vocabulary and lets tests assert coverage. */
export const AUDIT_ACTIONS = Object.freeze({
  PREPARE: "exec.prepare",
  SIGN: "exec.sign",
  BROADCAST: "exec.broadcast",
  POLICY_REJECT: "policy.reject",
  AUTH_GRANT: "auth.grant",
  AUTH_OK: "auth.verify.ok",
  AUTH_FAIL: "auth.verify.fail",
});

function defaultPath() {
  return configPath("audit-log.jsonl", "ORACLE_AUDIT_LOG", "MAD_AUDIT_LOG");
}

/** Deterministic JSON: object keys sorted recursively. Matches buzz-audit's
 *  canonical_json so the same detail hashes identically everywhere. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") +
    "}"
  );
}

// Fixed field order — changing it invalidates every existing chain. `stream`
// leads the hash so an entry cannot be lifted out of one stream's chain and
// re-verified inside another (the tenant-binding property buzz-audit gets from
// hashing community_id first). Presence tags (\x00 / \x01) distinguish a null
// field from an empty-string field so they can't collide.
export function computeHash(entry) {
  const h = createHash("sha256");
  h.update(String(entry.stream), "utf8");
  h.update(String(entry.seq), "utf8");
  h.update(String(entry.ts), "utf8");
  h.update(String(entry.action), "utf8");
  h.update(entry.actor == null ? "\x00" : "\x01" + entry.actor, "utf8");
  h.update(entry.objectId == null ? "\x00" : "\x01" + entry.objectId, "utf8");
  h.update(canonicalJson(entry.detail ?? null), "utf8");
  h.update(entry.prevHash ?? GENESIS_HASH, "utf8");
  return h.digest("hex");
}

function readAll(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // A corrupt/partial trailing line is surfaced by verifyChain, not silently
      // healed. Skip it here so the head lookup uses the last *valid* record.
    }
  }
  return out;
}

// Serialize appends within this process so read-head → append is atomic even
// under concurrent exec-server requests (mirrors buzz-audit's per-chain lock).
let appendQueue = Promise.resolve();

/**
 * Append one entry to the chain. Returns the full stored record.
 * @param {object} opts
 * @param {string} opts.action    one of AUDIT_ACTIONS (or a custom string)
 * @param {string} [opts.actor]   signer/owner address or agent id
 * @param {string} [opts.objectId] tx hash, chainId:to, grant id, ...
 * @param {object} [opts.detail]  hashed outcome metadata (NO secrets)
 * @param {string} [opts.stream]  logical chain label (default "mad-exec")
 * @param {string} [opts.path]    override log path (tests)
 */
export function appendAudit({ action, actor = null, objectId = null, detail = null, stream, path } = {}) {
  if (!action) throw new Error("audit: action required");
  const p = path || defaultPath();
  const strm = stream || env("ORACLE_AUDIT_STREAM", "MAD_AUDIT_STREAM", "oracle-exec");

  const run = appendQueue.then(() => {
    const existing = readAll(p).filter((e) => e.stream === strm);
    const head = existing.length ? existing[existing.length - 1] : null;
    const seq = head ? head.seq + 1 : 1;
    const prevHash = head ? head.hash : null;

    const entry = {
      stream: strm,
      seq,
      ts: new Date().toISOString(),
      action: String(action),
      actor: actor == null ? null : String(actor),
      objectId: objectId == null ? null : String(objectId),
      detail: detail ?? null,
      prevHash,
    };
    entry.hash = computeHash(entry);

    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + "\n", { mode: 0o600 });
    return entry;
  });

  // Keep the queue alive even if one append throws.
  appendQueue = run.catch(() => {});
  return run;
}

/**
 * Best-effort append that NEVER throws into the caller. Use on the live exec
 * path: a broken/unwritable log must not brick a signing operation, and every
 * entry that DID get written stays verifiable. Failures go to stderr.
 */
export async function recordAudit(opts) {
  try {
    return await appendAudit(opts);
  } catch (e) {
    try {
      process.stderr.write(
        JSON.stringify({ auditError: String(e?.message || e), action: opts?.action }) + "\n"
      );
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Verify a stream's chain end-to-end.
 * @returns {{ ok: boolean, count: number, reason?: string, seq?: number }}
 */
export function verifyChain({ stream, path } = {}) {
  const p = path || defaultPath();
  const strm = stream || env("ORACLE_AUDIT_STREAM", "MAD_AUDIT_STREAM", "oracle-exec");
  const rows = readAll(p).filter((e) => e.stream === strm);
  if (rows.length === 0) return { ok: false, count: 0, reason: "empty" };

  let expectedPrev = null;
  let expectedSeq = 1;
  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return { ok: false, count: rows.length, reason: "seq-gap", seq: row.seq };
    }
    const wantPrev = expectedSeq === 1 ? null : expectedPrev;
    if ((row.prevHash ?? null) !== (wantPrev ?? null)) {
      return { ok: false, count: rows.length, reason: "prev-hash-mismatch", seq: row.seq };
    }
    const { hash, ...bare } = row;
    if (computeHash(bare) !== hash) {
      return { ok: false, count: rows.length, reason: "hash-mismatch", seq: row.seq };
    }
    expectedPrev = hash;
    expectedSeq += 1;
  }
  return { ok: true, count: rows.length };
}

/** Read up to `limit` entries from `fromSeq` for a stream (newest-truncated). */
export function getEntries({ stream, fromSeq = 1, limit = 100, path } = {}) {
  const p = path || defaultPath();
  const strm = stream || env("ORACLE_AUDIT_STREAM", "MAD_AUDIT_STREAM", "oracle-exec");
  return readAll(p)
    .filter((e) => e.stream === strm && e.seq >= fromSeq)
    .slice(0, limit);
}
