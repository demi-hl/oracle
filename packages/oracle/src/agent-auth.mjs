// Owner-signed, self-verifying, time-bounded agent capability tokens.
//
// Adapted from block/buzz NIP-OA ("Owner Attestation") to MAD's EVM world.
// NIP-OA is Schnorr/BIP-340 over a nostr event; MAD signs ECDSA/EIP-191 with
// the same secp256k1 curve, so the credential format ports directly while the
// signature primitive becomes ethers `verifyMessage` (already used elsewhere).
//
// WHY: today MAD proves owner authority ONLY server-side (MAD_EXECUTOR_CONTROLLERS
// allowlist + key-hash + bearer). That is a denylist the server must carry. A
// capability is the complement: a self-contained grant the AGENT carries and
// presents, that the exec layer verifies without consulting a list, and that
// EXPIRES on its own. Revocation-by-expiry, not just server denial. For the
// multi-user agency version an owner key mints a scoped, expiring grant per
// client without the server tracking every delegation.
//
// A capability is: ["auth", <ownerAddress>, <conditions>, <signature>]
//   ownerAddress : 0x EVM address that authorized the agent
//   conditions   : "" or clause(&clause)*  — clauses below
//   signature    : owner EIP-191 signature over the preimage
//
// Preimage (exact bytes, order-sensitive — the owner signs this string):
//   "mad:agent-auth:" + <agentAddress-lowercased> + ":" + <conditions>
//
// Clauses (case-sensitive, no whitespace, canonical base-10):
//   chain=<decimal>        agent may act on this EVM chainId
//   action=<string>        agent may perform this action/scope (e.g. exec.broadcast)
//   expires<unix>          capability invalid at/after this wall-clock time
//   notbefore>unix         capability invalid before this wall-clock time
//
// Unlike NIP-OA (which constrains an agent-controlled event.created_at and so
// cannot enforce wall-clock expiry), MAD verifies a capability presented LIVE
// against real time, so `expires<`/`notbefore>` ARE enforced against the
// verifier clock here — the wall-clock enforcement NIP-OA defers to the caller.

import { verifyMessage, getAddress, isAddress } from "ethers";

export const AUTH_DOMAIN = "mad:agent-auth:";

/** Build the exact signing preimage. Owner signs this via personal_sign. */
export function authPreimage(agentAddress, conditions) {
  const a = String(agentAddress || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error("agentAddress must be a 0x 20-byte address");
  return AUTH_DOMAIN + a + ":" + String(conditions ?? "");
}

// Parse + validate the conditions string into typed clauses. Throws on any
// malformed clause (mirrors NIP-OA's strict rejection rules).
function parseConditions(conditions) {
  const out = { chains: new Set(), actions: new Set(), expires: null, notbefore: null };
  const s = String(conditions ?? "");
  if (s === "") return out; // empty imposes no constraints
  if (/\s/.test(s)) throw new Error("conditions: whitespace not permitted");
  if (s.startsWith("&") || s.endsWith("&") || s.includes("&&")) {
    throw new Error("conditions: empty clause");
  }
  const decimal = (v, max) => {
    if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`conditions: non-canonical decimal '${v}'`);
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`conditions: out of range '${v}'`);
    return n;
  };
  for (const clause of s.split("&")) {
    if (clause.startsWith("chain=")) {
      out.chains.add(decimal(clause.slice(6), 0xffffffff));
    } else if (clause.startsWith("action=")) {
      const v = clause.slice(7);
      if (!v) throw new Error("conditions: empty action");
      out.actions.add(v);
    } else if (clause.startsWith("expires<")) {
      out.expires = decimal(clause.slice(8), 0xffffffff);
    } else if (clause.startsWith("notbefore>")) {
      out.notbefore = decimal(clause.slice(10), 0xffffffff);
    } else {
      throw new Error(`conditions: unsupported clause '${clause}'`);
    }
  }
  return out;
}

/**
 * Verify an owner capability authorizes `agentAddress` for `{ chainId, action }`
 * right now. Pure + self-contained: no allowlist, no DB. Returns a result object
 * rather than throwing so the exec path can log a reason and fail closed.
 *
 * @param {[string,string,string,string]} tag  ["auth", owner, conditions, sig]
 * @param {object} ctx
 * @param {string} ctx.agentAddress  the agent key the capability was signed for
 * @param {number} [ctx.chainId]     chain the action targets (checked vs chain=)
 * @param {string} [ctx.action]      action/scope requested (checked vs action=)
 * @param {number} [ctx.now]         unix seconds override (tests)
 * @returns {{ ok: boolean, owner?: string, reason?: string }}
 */
export function verifyCapability(tag, { agentAddress, chainId = null, action = null, now = null } = {}) {
  if (!Array.isArray(tag) || tag.length !== 4 || tag[0] !== "auth") {
    return { ok: false, reason: "malformed-tag" };
  }
  const [, ownerRaw, conditions, sig] = tag;
  if (!isAddress(ownerRaw)) return { ok: false, reason: "bad-owner-address" };
  if (!isAddress(agentAddress)) return { ok: false, reason: "bad-agent-address" };

  const owner = getAddress(ownerRaw);
  // Self-attestation is meaningless — an agent can't authorize itself.
  if (owner.toLowerCase() === String(agentAddress).toLowerCase()) {
    return { ok: false, reason: "self-attestation" };
  }

  let parsed;
  try {
    parsed = parseConditions(conditions);
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }

  // Recover the signer from the exact preimage. Any tamper to agent/conditions
  // changes the preimage and the recovered address won't match the owner.
  let recovered;
  try {
    recovered = verifyMessage(authPreimage(agentAddress, conditions), sig);
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  if (recovered.toLowerCase() !== owner.toLowerCase()) {
    return { ok: false, reason: "signature-owner-mismatch" };
  }

  const t = now == null ? Math.floor(Date.now() / 1000) : Number(now);
  if (parsed.expires != null && t >= parsed.expires) return { ok: false, reason: "expired", owner };
  if (parsed.notbefore != null && t <= parsed.notbefore) return { ok: false, reason: "not-yet-valid", owner };
  if (parsed.chains.size > 0 && chainId != null && !parsed.chains.has(Number(chainId))) {
    return { ok: false, reason: "chain-not-authorized", owner };
  }
  if (parsed.actions.size > 0 && action != null && !parsed.actions.has(String(action))) {
    return { ok: false, reason: "action-not-authorized", owner };
  }
  return { ok: true, owner };
}

/**
 * Owner-side helper: given an owner ethers Signer, mint the capability tag for
 * an agent. Kept dependency-light — caller supplies the signer so the owner key
 * NEVER touches this module or the exec box.
 *
 * @param {import('ethers').Signer} ownerSigner
 * @param {string} agentAddress
 * @param {string} [conditions]
 * @returns {Promise<[string,string,string,string]>}
 */
export async function mintCapability(ownerSigner, agentAddress, conditions = "") {
  // Hardening: never accept a raw key string/hex. Real ethers Wallet/Signer objects are OK
  // (they may expose .privateKey internally — that is the wallet, not a mistaken string).
  if (typeof ownerSigner === "string" || typeof ownerSigner === "number") {
    throw new Error("mintCapability refuses raw key material — pass an ethers Signer from the owner wallet");
  }
  if (!ownerSigner || typeof ownerSigner.signMessage !== "function" || typeof ownerSigner.getAddress !== "function") {
    throw new Error("mintCapability: ownerSigner must implement getAddress() and signMessage()");
  }
  // Bare POJO that only carries a key field (no prototype signer) — refuse.
  const proto = Object.getPrototypeOf(ownerSigner);
  if (proto === Object.prototype || proto === null) {
    if (ownerSigner.privateKey || ownerSigner.mnemonic) {
      throw new Error("mintCapability refuses plain objects that only carry privateKey/mnemonic");
    }
  }
  parseConditions(conditions); // validate before signing
  const owner = await ownerSigner.getAddress();
  if (owner.toLowerCase() === String(agentAddress).toLowerCase()) {
    throw new Error("owner and agent must differ");
  }
  const sig = await ownerSigner.signMessage(authPreimage(agentAddress, conditions));
  return ["auth", getAddress(owner), String(conditions), sig];
}

/**
 * Gate decision: a capability verifies AND its owner is one MAD trusts.
 *
 * `verifyCapability` proves *some* owner signed the grant; on its own that is
 * not authorization — anyone can sign a grant for the agent from a random key.
 * This adds the missing half: the recovered owner must be in the trusted
 * `owners` set. BOTH must hold. Fails CLOSED — an empty trusted set denies
 * every request (so turning the gate on without configuring owners cannot
 * silently allow-all).
 *
 * Pure: no env, no I/O, no clock unless `now` omitted. The exec layer supplies
 * env-derived `required`/`owners` and records the outcome to the audit chain.
 *
 * @param {[string,string,string,string]} tag
 * @param {object} ctx
 * @param {string} ctx.agentAddress   agent the capability must authorize
 * @param {number} [ctx.chainId]      chain the action targets
 * @param {string} [ctx.action]       action/scope requested
 * @param {string[]} [ctx.owners]     trusted owner addresses (allowlist)
 * @param {number} [ctx.now]          unix seconds override (tests)
 * @returns {{ ok: boolean, owner?: string, reason?: string }}
 */
export function requireCapability(tag, { agentAddress, chainId = null, action = null, owners = [], now = null } = {}) {
  const allow = new Set(
    (owners || []).map((a) => String(a).toLowerCase()).filter(Boolean)
  );
  if (allow.size === 0) return { ok: false, reason: "no-trusted-owners" };
  const r = verifyCapability(tag, { agentAddress, chainId, action, now });
  if (!r.ok) return r;
  if (!allow.has(r.owner.toLowerCase())) {
    return { ok: false, reason: "owner-not-trusted", owner: r.owner };
  }
  return { ok: true, owner: r.owner };
}
