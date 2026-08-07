/**
 * Durable labeled address book for owner/agent/counterparty wallets.
 *
 * On by default: remembering who an address belongs to is a read/annotate
 * concern, not an execution one. Nothing here signs, and no private key,
 * passphrase, or seed is ever accepted or stored.
 */
import fs from "node:fs";
import path from "node:path";
import { ORACLE_CONFIG_DIR, env } from "./oracle-env.mjs";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const FORBIDDEN_KEYS = new Set([
  "privatekey", "private_key", "secret", "seed", "mnemonic", "passphrase", "signature", "keystore",
]);

// Exact-name matching missed obvious aliases (secretKey, seedPhrase, wif,
// keyMaterial, xprv...). Match on a normalized key instead: strip separators,
// lowercase, then look for any secret-ish token as a substring. A label store
// has no legitimate field containing these words.
const FORBIDDEN_TOKENS = [
  "privatekey", "privkey", "secretkey", "secret", "seedphrase", "seed", "mnemonic",
  "passphrase", "password", "keystore", "keymaterial", "signature", "wif",
  "xprv", "xpriv", "apikey", "bearer", "credential",
];

// Key-shaped values must not be persisted even in a free-text field. WIF, xprv,
// and BIP39 shapes are unambiguous. A bare 64-hex string is NOT — a raw EVM
// private key and a bytes32 tx hash are byte-identical — so that rule matches
// only when the WHOLE field is the hex blob. "paid via tx 0xabc..." is a note,
// not a leaked key.
const KEY_SHAPED_VALUE = [
  /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/,
  /\bxprv[0-9A-Za-z]{50,}\b/,
  /\b(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\b/i,
];

const BARE_32_BYTE_HEX = /^\s*(?:0x)?[0-9a-fA-F]{64}\s*$/;

function normalizeKeyName(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertNoSecretKeyName(key, path) {
  const normalized = normalizeKeyName(key);
  if (FORBIDDEN_KEYS.has(String(key).toLowerCase()) || FORBIDDEN_TOKENS.some((t) => normalized.includes(t))) {
    throw new Error(`address-book: ${path} is forbidden; the book stores labels, never key material`);
  }
}

function assertNoSecretValue(value, path) {
  if (typeof value !== "string") return;
  if (KEY_SHAPED_VALUE.some((re) => re.test(value)) || BARE_32_BYTE_HEX.test(value)) {
    throw new Error(`address-book: ${path} looks like key material; the book stores labels, never key material`);
  }
}

export function addressBookPath() {
  const override = env("ORACLE_ADDRESS_BOOK", "MAD_ADDRESS_BOOK", "");
  if (override) return path.resolve(override);
  const dir = env("ORACLE_CONFIG_DIR", "MAD_CONFIG_DIR", ORACLE_CONFIG_DIR);
  return path.join(dir, "address-book.json");
}

function assertNoSecrets(input, path = "field") {
  if (Array.isArray(input)) {
    input.forEach((item, i) => assertNoSecrets(item, `${path}[${i}]`));
    return;
  }
  if (!input || typeof input !== "object") {
    assertNoSecretValue(input, path);
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    assertNoSecretKeyName(key, key);
    assertNoSecrets(value, key);
  }
}

function normalizeAddress(value) {
  const address = String(value || "").trim();
  if (!ADDR_RE.test(address)) throw new Error("address-book: address must be 0x + 40 hex characters");
  return address.toLowerCase();
}

function text(value, max) {
  if (value == null || value === "") return null;
  return String(value).slice(0, max);
}

function emptyBook() {
  return { version: 1, updatedAt: null, entries: [] };
}

function normalizeEntry(entry) {
  return {
    address: String(entry.address).toLowerCase(),
    label: text(entry.label, 80) || "unknown",
    who: text(entry.who, 120),
    role: text(entry.role, 40),
    chainIds: Array.isArray(entry.chainIds) ? entry.chainIds.map(Number).filter(Number.isFinite) : [],
    notes: text(entry.notes, 500),
    source: text(entry.source, 80),
    firstSeenAt: entry.firstSeenAt || null,
    lastSeenAt: entry.lastSeenAt || null,
  };
}

export function readAddressBook() {
  try {
    const raw = JSON.parse(fs.readFileSync(addressBookPath(), "utf8"));
    if (!raw || typeof raw !== "object") return emptyBook();
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    return {
      version: 1,
      updatedAt: raw.updatedAt || null,
      entries: entries
        .filter((entry) => entry && typeof entry === "object" && ADDR_RE.test(String(entry.address || "")))
        .map(normalizeEntry),
    };
  } catch {
    return emptyBook();
  }
}

function writeBook(book) {
  const file = addressBookPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = { ...book, version: 1, updatedAt: new Date().toISOString() };
  const tmp = path.join(path.dirname(file), `.address-book.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without chmod semantics */
  }
  return payload;
}

export function listAddresses(filter = {}) {
  const book = readAddressBook();
  let entries = book.entries;
  if (filter.role) entries = entries.filter((entry) => entry.role === String(filter.role));
  if (filter.who) {
    const query = String(filter.who).toLowerCase();
    entries = entries.filter(
      (entry) => (entry.who || "").toLowerCase().includes(query) || (entry.label || "").toLowerCase().includes(query),
    );
  }
  if (filter.q) {
    const query = String(filter.q).toLowerCase();
    entries = entries.filter(
      (entry) =>
        entry.address.includes(query) ||
        (entry.label || "").toLowerCase().includes(query) ||
        (entry.who || "").toLowerCase().includes(query) ||
        (entry.notes || "").toLowerCase().includes(query),
    );
  }
  return { updatedAt: book.updatedAt, count: entries.length, entries };
}

export function lookupAddress(address) {
  const normalized = normalizeAddress(address);
  const entries = readAddressBook().entries.filter((entry) => entry.address === normalized);
  return { address: normalized, found: entries.length > 0, entries };
}

export function rememberAddress(input = {}) {
  assertNoSecrets(input);
  const address = normalizeAddress(input.address);
  const label = text(input.label ?? input.role, 80) || "wallet";
  const now = new Date().toISOString();
  const book = readAddressBook();
  const index = book.entries.findIndex((entry) => entry.address === address && entry.label === label);
  const entry = normalizeEntry({
    address,
    label,
    who: input.who,
    role: input.role,
    chainIds: input.chainIds,
    notes: input.notes,
    source: input.source || "agent",
    firstSeenAt: index >= 0 ? book.entries[index].firstSeenAt || now : now,
    lastSeenAt: now,
  });
  if (index >= 0) book.entries[index] = entry;
  else book.entries.push(entry);
  const rank = (role) => (role === "agent" ? 0 : role === "owner" ? 1 : 2);
  book.entries.sort(
    (a, b) => rank(a.role) - rank(b.role) || a.label.localeCompare(b.label) || a.address.localeCompare(b.address),
  );
  const saved = writeBook(book);
  return { ok: true, entry, count: saved.entries.length };
}

export function forgetAddress(address, label = null) {
  const normalized = normalizeAddress(address);
  const book = readAddressBook();
  const before = book.entries.length;
  book.entries = book.entries.filter((entry) => {
    if (entry.address !== normalized) return true;
    return label == null ? false : entry.label !== String(label);
  });
  writeBook(book);
  return { ok: true, removed: before - book.entries.length, count: book.entries.length };
}
