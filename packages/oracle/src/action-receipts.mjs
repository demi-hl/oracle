// Deterministic, public-only receipts for prepared and executed actions.
//
// This module deliberately has no authority and no I/O: it does not authorize,
// sign, broadcast, or fetch. It only records facts supplied by its caller.

import { createHash } from "node:crypto";
import { wordlists } from "ethers";

export const ACTION_RECEIPT_VERSION = 1;

// Key-name matching was exact-ish and only covered five words, so every wallet
// export alias (secretKey, seedPhrase, wif, keyMaterial, privKey, xprv, seed,
// keystore) sailed through. There was also NO value-shape rule, so a raw key or
// a BIP-39 phrase pasted into a benign field like `memo` was recorded verbatim.
//
// Both concerns were already solved in src/address-book.mjs; this module simply
// did not use the hardened list. Found by the opus lane of the 2026-08-03
// four-model review, and verified to PERSIST: unknown top-level props are
// dropped by the schema whitelist, but a secret nested inside a RETAINED field
// (intent, route, decodedAction) survives into the frozen receipt.
const SECRET_KEYS = new Set([
  "privatekey",
  "privkey",
  "secretkey",
  "seedphrase",
  "seed",
  "mnemonic",
  "passphrase",
  "password",
  "keystore",
  "keymaterial",
  "wif",
  "xprv",
  "xpriv",
  "bearer",
  "authorization",
  "signature",
  "apikey",
  "credential",
]);

// Unambiguous key shapes: WIF, extended private key, BIP-39 word run. These are
// refused wherever they appear.
//
// A bare 64-hex string is deliberately NOT in this list. A raw EVM private key
// and a bytes32 tx hash are byte-identical, and receipts legitimately carry
// txHash / orderHash / salt / merkleRoot / nonce. Blanket-refusing 64-hex would
// break real receipts — an over-tight filter is its own bug. It is instead
// gated on the field name below.
const KEY_SHAPED_VALUE = [
  /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/,
  /\bxprv[0-9A-Za-z]{50,}\b/,
];

const BIP39_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

function isBip39EnglishPhrase(value) {
  const words = String(value).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return BIP39_WORD_COUNTS.has(words.length) && words.every((word) => wordlists.en.getWordIndex(word) >= 0);
}

const BARE_32_BYTE_HEX = /^\s*(?:0x)?[0-9a-fA-F]{64}\s*$/;

// Field names whose whole value is EXPECTED to be a 32-byte digest.
//
// The trailing `(?:e?s)?` matters: `publicValue` scans array leaves using the
// PARENT key, so a batched route's `orderHashes` / `proofs` / `commitments`
// arrives here in its plural form (English pluralizes `hash` as `hashes`).
// Without it a digest LIST is refused while the exact same digest in singular
// form is accepted — an over-tight filter that breaks real receipts and blocks
// no secret (key-SHAPED values are refused by KEY_SHAPED_VALUE / BIP-39
// regardless of field name).
const DIGEST_FIELD = /(hash|digest|root|salt|nonce|proof|commitment|sig|id)(?:e?s)?$/i;
const PROTOCOL_HEX_FIELDS = new Set([
  "calldata",
  "data",
  "publickey",
  "pubkey",
  "message",
  "payload",
  "input",
  "extradata",
]);

function allows32ByteHex(key) {
  const normalized = normalizedKey(key);
  return PROTOCOL_HEX_FIELDS.has(normalized) || DIGEST_FIELD.test(normalized);
}

export class ActionReceiptSecretError extends Error {
  constructor(path) {
    super(`action receipt refused: secret-bearing field at ${path}`);
    this.name = "ActionReceiptSecretError";
    this.code = "ACTION_RECEIPT_SECRET";
  }
}

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSecretKey(key) {
  const normalized = normalizedKey(key);
  return [...SECRET_KEYS].some((secret) => normalized.includes(secret));
}

/**
 * Refuse a key-material-shaped VALUE, so a secret pasted into a benign field
 * name (memo, note, label) cannot be recorded verbatim.
 *
 * Bare 64-hex is only refused when the field name is NOT digest-shaped: a raw
 * EVM private key and a bytes32 hash are byte-identical, and receipts carry
 * txHash / orderHash / salt / nonce legitimately.
 */
function assertNoSecretValue(key, value, path) {
  if (typeof value !== "string") return;
  if (KEY_SHAPED_VALUE.some((re) => re.test(value)) || isBip39EnglishPhrase(value)) {
    throw new ActionReceiptSecretError(path);
  }
  if (BARE_32_BYTE_HEX.test(value) && !allows32ByteHex(key)) {
    throw new ActionReceiptSecretError(path);
  }
}

function publicValue(value, path = "$", key = "") {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertNoSecretValue(key, value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`action receipt: non-finite number at ${path}`);
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item, index) => publicValue(item, `${path}[${index}]`, key));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`action receipt: JSON-like value required at ${path}`);
  }

  const out = {};
  for (const childKey of Object.keys(value).sort()) {
    const childPath = `${path}.${childKey}`;
    if (isSecretKey(childKey)) throw new ActionReceiptSecretError(childPath);
    if (value[childKey] !== undefined) out[childKey] = publicValue(value[childKey], childPath, childKey);
  }
  return out;
}

/** Recursively reject secret-bearing fields and return a detached public copy. */
export function assertNoReceiptSecrets(value) {
  return publicValue(value);
}

function canonicalPublicJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPublicJson).join(",")}]`;
  return `{${Object.keys(value).map((key) => `${JSON.stringify(key)}:${canonicalPublicJson(value[key])}`).join(",")}}`;
}

/** Canonical JSON with recursively sorted object keys. */
export function canonicalReceiptJson(value) {
  return canonicalPublicJson(publicValue(value));
}

/** Hash exactly the public receipt fields, excluding the self-referential id. */
export function computeReceiptId(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("action receipt: object required");
  }
  const { receiptId: _ignored, summary: _derived, ...publicFields } = receipt;
  return createHash("sha256").update(canonicalReceiptJson(publicFields)).digest("hex");
}

function supplied(input, ...keys) {
  for (const key of keys) if (input[key] !== undefined) return input[key];
  return undefined;
}

function required(input, keys, label) {
  const value = supplied(input, ...keys);
  if (value === undefined || value === null) throw new TypeError(`action receipt: ${label} required`);
  return value;
}

function balanceFields(input) {
  const balances = supplied(input, "balances", "balanceChanges");
  const before = supplied(input, "beforeBalances", "balancesBefore", "before");
  const after = supplied(input, "afterBalances", "balancesAfter", "after");
  if (balances !== undefined) return { balances };
  if (before === undefined && after === undefined) return {};
  return { balances: { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) } };
}

/**
 * Normalize caller-supplied prepare/execute facts into the versioned schema.
 * Unknown input fields are intentionally omitted from the receipt.
 */
export function normalizeActionReceipt(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("action receipt: input object required");
  }
  // Scan the complete input before selecting fields so a secret cannot be
  // hidden in an otherwise unknown property and accidentally appear later.
  publicValue(input);

  const txHash = supplied(input, "txHash", "transactionHash");
  const phase = supplied(input, "phase", "stage", "resultType") ?? (txHash == null ? "prepare" : "execute");
  if (phase !== "prepare" && phase !== "execute") {
    throw new TypeError('action receipt: phase must be "prepare" or "execute"');
  }

  const fields = {
    receiptVersion: ACTION_RECEIPT_VERSION,
    phase,
    intent: required(input, ["intent"], "intent"),
    route: required(input, ["route"], "route"),
    decodedAction: required(input, ["decodedAction", "action"], "decodedAction"),
    policyChecks: required(input, ["policyChecks", "checks"], "policyChecks"),
    allowlistHits: required(input, ["allowlistHits", "allowlistMatches"], "allowlistHits"),
    prepareHash: required(input, ["prepareHash"], "prepareHash"),
    ...(txHash == null ? {} : { txHash }),
    ...balanceFields(input),
  };
  const receipt = publicValue(fields);
  return Object.freeze({ ...receipt, receiptId: computeReceiptId(receipt) });
}

export const createActionReceipt = normalizeActionReceipt;

function label(value, preferred = []) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  for (const key of preferred) if (value?.[key] != null) return String(value[key]);
  return "recorded";
}

function checkResult(check) {
  if (typeof check === "boolean") return check;
  if (check && typeof check === "object") {
    if (typeof check.ok === "boolean") return check.ok;
    if (typeof check.allowed === "boolean") return check.allowed;
    if (typeof check.passed === "boolean") return check.passed;
  }
  return null;
}

/** Produce a compact human-readable statement without changing the receipt. */
export function summarizeActionReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") throw new TypeError("action receipt: object required");
  const action = label(receipt.decodedAction, ["type", "action", "method", "name"]);
  const route = label(receipt.route, ["name", "provider", "venue", "id"]);
  const checks = Array.isArray(receipt.policyChecks)
    ? receipt.policyChecks
    : Object.values(receipt.policyChecks || {});
  const passed = checks.filter((check) => checkResult(check) === true).length;
  const failed = checks.filter((check) => checkResult(check) === false).length;
  const hits = Array.isArray(receipt.allowlistHits)
    ? receipt.allowlistHits.length
    : Object.keys(receipt.allowlistHits || {}).length;
  const tx = receipt.txHash == null ? "no transaction hash" : `tx ${receipt.txHash}`;
  const balances = receipt.balances == null ? "balances not provided" : "before/after balances recorded";
  return `${receipt.phase} ${action} via ${route}; policy ${passed} passed, ${failed} failed; ${hits} allowlist hit${hits === 1 ? "" : "s"}; ${tx}; ${balances}; receipt ${receipt.receiptId}`;
}

export const formatActionReceipt = summarizeActionReceipt;
