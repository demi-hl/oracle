// Oracle Router proposal model.
//
// Pure, dependency-free. A "proposal" is an advisory object: a labeled
// suggestion for what Oracle Control *could* do, carrying no authority of its
// own. This module MUST NEVER be able to produce an object that authorizes,
// signs, or broadcasts anything, and MUST NEVER accept or echo back secrets
// (bearer tokens, private/session keys, passphrases, keystore paths, etc.).
//
// Enforcement is defense-in-depth, in this order:
//   1. Reject: any dangerous field anywhere in the input throws immediately.
//   2. Strip: the emitted proposal is built from an explicit field allowlist
//      only (nothing "extra" from the input can leak through even if step 1
//      had a gap).
//   3. Pin: every proposal carries fixed, non-overridable advisory markers
//      (mode: "proposal", authorized: false, signed: false, broadcast: false)
//      that the caller cannot set to anything else.
//   4. Freeze: the returned proposal (and its nested plain objects/arrays)
//      is deep-frozen so downstream code cannot mutate it into something
//      that looks authorized.

import { classifyRisk } from "./risk-classifier.mjs";

// Case-insensitive key patterns that must never appear anywhere in a
// proposal request or its emitted output. Deliberately broad: it is safer to
// over-reject an oddly named benign field than to under-reject a secret.
export const DANGEROUS_FIELD_PATTERNS = Object.freeze([
  /priv(ate)?[-_ ]?key/i,
  /seed[-_ ]?phrase/i,
  /mnemonic/i,
  /api[-_ ]?key/i,
  /api[-_ ]?secret/i,
  /bearer/i,
  /session[-_ ]?key/i,
  /session[-_ ]?secret/i,
  /session[-_ ]?token/i,
  /keystore/i,
  /passphrase/i,
  /^password$/i,
  /secret/i,
  /signature/i,
  /signed[-_ ]?tx/i,
  /raw[-_ ]?tx/i,
  /broadcast/i,
  /authoriz/i,
  /^grant$/i,
  /grant[-_ ]?token/i,
  /credential/i,
  /house[-_ ]?wallet/i,
  /executor[-_ ]?token/i,
  /access[-_ ]?token/i,
  /^token$/i,
  /^sig$/i,
  /wallet[-_ ]?key/i,
]);

// Exact key names the router itself emits as PINNED, hardcoded-false/fixed
// advisory markers (see createProposal below). These key names happen to
// match the dangerous-field patterns above (e.g. "authorized" contains
// "authoriz", "canAccessSecrets" contains "secret") precisely BECAUSE they
// exist to make the proposal's non-authority explicit and readable. They are
// only ever assigned literal constants by this module, never taken from
// caller input, so allowing them past the OUTPUT-side scan is safe. This
// allowlist is NEVER applied when scanning untrusted caller input.
const PINNED_SAFE_OUTPUT_KEYS = new Set([
  "mode",
  "advisoryOnly",
  "authorized",
  "signed",
  "broadcast",
  "requiresHumanConfirmation",
  "grantsPermissions",
  "capabilities",
  "canClassifyRisk",
  "canExplain",
  "canSimulate",
  "canSign",
  "canBroadcast",
  "canAuthorize",
  "canMintCapability",
  "canAccessSecrets",
]);

function isDangerousKey(key, { allowPinnedSafe = false } = {}) {
  const k = String(key);
  if (allowPinnedSafe && PINNED_SAFE_OUTPUT_KEYS.has(k)) return false;
  return DANGEROUS_FIELD_PATTERNS.some((re) => re.test(k));
}

/**
 * Recursively scan a value for keys matching DANGEROUS_FIELD_PATTERNS.
 * Returns a list of dotted paths where a dangerous key was found. Pure,
 * read-only -- never mutates the input.
 *
 * @param {*} value
 * @param {string} [pathPrefix]
 * @param {object} [opts]
 * @param {boolean} [opts.allowPinnedSafe] when true, exempts this module's own
 *   fixed advisory-marker key names (see PINNED_SAFE_OUTPUT_KEYS). Only ever
 *   pass this when scanning output THIS module constructed itself -- never
 *   when scanning caller-supplied input.
 */
export function findDangerousFields(value, pathPrefix = "", opts = {}) {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      hits.push(...findDangerousFields(item, `${pathPrefix}[${i}]`, opts));
    });
    return hits;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      const path = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (isDangerousKey(key, opts)) hits.push(path);
      hits.push(...findDangerousFields(val, path, opts));
    }
    return hits;
  }
  return hits;
}

/** Throws if `value` contains any dangerous field anywhere, at any depth.
 *  Pass { allowPinnedSafe: true } ONLY for output this module itself built. */
export function assertNoDangerousFields(value, label = "proposal input", opts = {}) {
  const hits = findDangerousFields(value, "", opts);
  if (hits.length) {
    throw new Error(
      `${label} contains disallowed secret/signing/broadcast field(s): ${hits.join(", ")}`
    );
  }
}

/** Deep-clones plain objects/arrays with any dangerous keys removed. Defense
 *  in depth only -- createProposal() rejects rather than relying on this to
 *  silently clean up the input. */
export function stripDangerousFields(value) {
  if (Array.isArray(value)) return value.map(stripDangerousFields);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (isDangerousKey(key)) continue;
      out[key] = stripDangerousFields(val);
    }
    return out;
  }
  return value;
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    return Object.freeze(value);
  }
  return value;
}

// Fields the router is allowed to read off a proposal request. Anything not
// in this list is dropped when the proposal is built, regardless of what the
// caller sent -- this is what makes step 2 (Strip) effective even if a
// dangerous field used a name the regex list hasn't seen yet.
const ALLOWED_INPUT_FIELDS = Object.freeze([
  "kind",
  "target",
  "notionalUsd",
  "chainId",
  "venue",
  "destinationKnown",
  "unlimitedApproval",
  "crossChain",
  "note",
]);

function pickAllowed(input) {
  const out = {};
  for (const key of ALLOWED_INPUT_FIELDS) {
    if (input && Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) {
      out[key] = input[key];
    }
  }
  return out;
}

let proposalCounter = 0;
function nextProposalId(nowMs) {
  proposalCounter += 1;
  return `proposal-${nowMs}-${proposalCounter}`;
}

/**
 * Build an advisory-only proposal object. Never authorizes, signs, or
 * broadcasts anything; the returned object cannot be mistaken for one that
 * does because its authority markers are pinned to false/"proposal" and it is
 * deep-frozen.
 *
 * @param {object} input
 * @param {string} input.kind            see risk-classifier.mjs for recognized kinds
 * @param {string} [input.target]        human-readable description of the target (e.g. "HL BTC-PERP")
 * @param {number} [input.notionalUsd]
 * @param {number} [input.chainId]
 * @param {string} [input.venue]
 * @param {boolean} [input.destinationKnown]
 * @param {boolean} [input.unlimitedApproval]
 * @param {boolean} [input.crossChain]
 * @param {string} [input.note]          free-text rationale; itself scanned for dangerous fields if an object is passed by mistake
 * @param {number} [nowMs]               injectable clock for deterministic tests
 * @returns {object} frozen proposal
 */
export function createProposal(input = {}, nowMs = Date.now()) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("proposal input must be a plain object");
  }

  // Step 1: reject. Scan the FULL raw input (not just the allowlisted
  // subset) so a caller cannot smuggle a secret in under an allowed key name
  // collision, nor bury one in an unlisted field and have it silently
  // dropped without anyone noticing the attempt.
  assertNoDangerousFields(input, "proposal input");

  const kind = String(input.kind || "").trim().toLowerCase();
  if (!kind) throw new Error("proposal input: kind is required");

  // Step 2: strip / allowlist. Only known-safe fields are read from input.
  const safeInput = pickAllowed(input);
  safeInput.kind = kind;

  const risk = classifyRisk({
    kind,
    notionalUsd: safeInput.notionalUsd,
    destinationKnown: safeInput.destinationKnown,
    unlimitedApproval: safeInput.unlimitedApproval,
    crossChain: safeInput.crossChain,
  });

  const proposal = {
    id: nextProposalId(Number(nowMs) || Date.now()),
    createdAt: new Date(Number(nowMs) || Date.now()).toISOString(),

    kind: safeInput.kind,
    target: safeInput.target != null ? String(safeInput.target) : null,
    notionalUsd: safeInput.notionalUsd != null ? Number(safeInput.notionalUsd) : null,
    chainId: safeInput.chainId != null ? Number(safeInput.chainId) : null,
    venue: safeInput.venue != null ? String(safeInput.venue) : null,
    note: safeInput.note != null ? String(safeInput.note) : null,

    risk: {
      tier: risk.tier,
      score: risk.score,
      reasons: risk.reasons,
    },

    // Step 3: pinned advisory markers. These are NOT derived from input and
    // cannot be overridden by any input field -- they are literal constants.
    mode: "proposal",
    advisoryOnly: true,
    authorized: false,
    signed: false,
    broadcast: false,
    requiresHumanConfirmation: true,
    grantsPermissions: false,
    capabilities: Object.freeze({
      canClassifyRisk: true,
      canExplain: true,
      canSimulate: kind === "simulate",
      canSign: false,
      canBroadcast: false,
      canAuthorize: false,
      canMintCapability: false,
      canAccessSecrets: false,
    }),
  };

  // Belt-and-suspenders: re-verify the object we are about to hand out
  // contains no dangerous keys before freezing, in case a future edit to
  // ALLOWED_INPUT_FIELDS accidentally lets one through. allowPinnedSafe is
  // required here because this module's own fixed advisory markers (e.g.
  // "authorized", "broadcast", "canAccessSecrets") intentionally reuse
  // wording from the dangerous-pattern list to stay self-documenting; they
  // are hardcoded constants above, never derived from input.
  assertNoDangerousFields(proposal, "proposal output", { allowPinnedSafe: true });

  return deepFreeze(proposal);
}

/**
 * Defense-in-depth guard for anything downstream that receives a proposal
 * object from the router and wants to double check, before acting on it in
 * any way, that it really is advisory-only. Throws if the object does not
 * look like a well-formed, unauthorized proposal.
 */
export function assertAdvisoryProposal(proposal) {
  if (!proposal || typeof proposal !== "object") {
    throw new Error("proposal required");
  }
  if (proposal.mode !== "proposal") throw new Error("proposal: mode must be \"proposal\"");
  if (proposal.authorized !== false) throw new Error("proposal: authorized must be false");
  if (proposal.signed !== false) throw new Error("proposal: signed must be false");
  if (proposal.broadcast !== false) throw new Error("proposal: broadcast must be false");
  if (proposal.advisoryOnly !== true) throw new Error("proposal: advisoryOnly must be true");
  if (proposal.grantsPermissions !== false) {
    throw new Error("proposal: grantsPermissions must be false");
  }
  const caps = proposal.capabilities || {};
  if (caps.canSign || caps.canBroadcast || caps.canAuthorize || caps.canMintCapability || caps.canAccessSecrets) {
    throw new Error("proposal: capabilities must not grant sign/broadcast/authorize/mint/secret access");
  }
  assertNoDangerousFields(proposal, "proposal", { allowPinnedSafe: true });
  return true;
}
