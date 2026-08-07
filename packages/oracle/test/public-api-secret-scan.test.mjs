import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNoSecretMaterial,
  assertSerializedNoSecrets,
  SecretLeakError,
} from "../src/public-api/connect-agent.mjs";
import { handleBuzzAuditAppend } from "../src/public-api/buzz-integration.mjs";

const PK = "0x" + "a".repeat(64);
const BARE = "b".repeat(64);

/** Build a structurally valid WIF from fresh entropy, at test time. */
function randomWif({ testnet = false, compressed = true } = {}) {
  const payload = Buffer.concat([
    Buffer.from([testnet ? 0xef : 0x80]),
    randomBytes(32),
    ...(compressed ? [Buffer.from([0x01])] : []),
  ]);
  const sha = (b) => createHash("sha256").update(b).digest();
  const checksum = sha(sha(payload)).subarray(0, 4);
  const full = Buffer.concat([payload, checksum]);
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + full.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of full) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** Build an extended-key-shaped value without committing key material. */
function syntheticExtendedKey(prefix) {
  return prefix + "A".repeat(107);
}

/** Mirrors http.mjs send(): scan the graph, then scan the bytes. */
function sendSim(body) {
  try {
    assertNoSecretMaterial(body);
    return { status: 200, wire: assertSerializedNoSecrets(body) };
  } catch {
    return { status: 500, wire: JSON.stringify({ error: "secret-leak-blocked" }) };
  }
}

function assertBlocked(label, body, needle) {
  const r = sendSim(body);
  assert.equal(r.status, 500, `${label}: expected 500`);
  assert.equal(r.wire, '{"error":"secret-leak-blocked"}', `${label}: wrong envelope`);
  if (needle) {
    assert.ok(!r.wire.includes(needle), `${label}: secret bytes reached the wire`);
  }
}

function assertBlockedByBothScans(label, body, needle) {
  assert.throws(
    () => assertNoSecretMaterial(body),
    SecretLeakError,
    `${label}: object-graph scan must block`
  );
  assert.throws(
    () => assertSerializedNoSecrets(body),
    SecretLeakError,
    `${label}: serialized-byte scan must block`
  );
  assertBlocked(label, body, needle);
}

test("toJSON() cannot smuggle a key past the scan", () => {
  // THE bug this suite exists for: a graph-only scan never visits the value
  // toJSON() produces, so the object scanned and the bytes sent differ.
  // Verified pre-fix: status 200 with the raw key in the response body.
  assertBlocked(
    "toJSON smuggle",
    { safe: "ok", nested: { toJSON() { return PK; } } },
    "a".repeat(64)
  );
});

test("a getter cannot smuggle a key", () => {
  assertBlocked("getter", { get privKey() { return PK; } }, "a".repeat(64));
});

test("bare 64-hex (no 0x prefix) is caught", () => {
  assertBlocked("bare hex", { k: BARE }, BARE);
});

test("a key concatenated into prose is caught", () => {
  assertBlocked("embedded in sentence", { note: `the key is ${PK} fyi` }, "a".repeat(64));
});

test("mainnet and testnet-uncompressed bitcoin WIF are caught", () => {
  // Generated at test time so no key-shaped literal is ever committed. A real
  // WIF in a public repo trains people to ignore secret-scanner hits, and a
  // scanner people ignore is worse than no scanner.
  for (const [label, wif] of [
    ["mainnet compressed WIF", randomWif()],
    ["testnet uncompressed WIF", randomWif({ testnet: true, compressed: false })],
  ]) {
    assertBlockedByBothScans(label, { k: wif }, wif);
  }
});

test("a BIP-39 mnemonic is caught", () => {
  const words = "abandon ".repeat(11) + "about";
  assertBlocked("mnemonic", { k: words }, "abandon");
});

test("extended private keys, key aliases, and bearer tokens are caught by both scans", () => {
  for (const prefix of ["xprv", "tprv", "yprv", "zprv"]) {
    const extendedKey = syntheticExtendedKey(prefix);
    assertBlockedByBothScans(`${prefix} extended private key`, { value: extendedKey }, extendedKey);
  }

  for (const alias of [
    "privkey",
    "Priv_Key",
    "PRIV-KEY",
    "wif",
    "W_I_F",
    "w-i-f",
    "xprv",
    "X_P_R_V",
    "x-prv",
    "seed",
    "S_E_E_D",
    "s-e-e-d",
  ]) {
    assertBlockedByBothScans(`key alias ${alias}`, { [alias]: "synthetic-test-value" });
  }

  assertBlockedByBothScans("bearer", { a: "Bearer abc123xyz" });
});

test("unserializable payloads and rejected audit details fail closed", async () => {
  const circular = {};
  circular.self = circular;
  assertBlocked("circular", circular);

  const dir = mkdtempSync(join(tmpdir(), "oracle-secret-audit-"));
  const path = join(dir, "audit.jsonl");
  const extendedKey = syntheticExtendedKey("xprv");
  try {
    let result;
    let failure;
    try {
      result = await handleBuzzAuditAppend(
        { action: "buzz.ping", detail: { value: extendedKey } },
        { path }
      );
    } catch (error) {
      failure = error;
    }

    assert.equal(failure?.code, "secret-leak-blocked", "audit append must reject before persistence");
    assert.equal(result, undefined, "rejected audit detail must not be echoed in a response");
    assert.equal(
      String(failure).includes(extendedKey),
      false,
      "rejection error must not echo secret-shaped detail"
    );
    assert.equal(existsSync(path), false, "rejected audit detail must not create the audit log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caller-supplied nonce cannot launder key material", () => {
  // `nonce` is attacker-controlled on the public path, so it must NOT be
  // treated as a public hex identifier the way grantId/txHash are.
  assertBlocked("poisoned nonce", { nonce: PK }, "a".repeat(64));
  assertBlocked("poisoned salt", { salt: PK }, "a".repeat(64));
});

test("legitimate public identifiers are NOT false-positived", () => {
  // A scanner that blocks normal traffic gets turned off, so this matters as
  // much as the blocking behaviour. Grant ids and tx hashes are public sha256.
  for (const [label, body] of [
    ["grantId", { grantId: BARE, action: "swap" }],
    ["txHash", { txHash: "0x" + "c".repeat(64) }],
    ["sha256 digest", { signing: { sha256: BARE } }],
    ["address", { address: "0x00000000000000000000000000000000000A1ce5" }],
    ["prose quoting a grant id", { render: `Authorize grant ${BARE} for swap` }],
    ...["xpub", "tpub", "ypub", "zpub"].map((prefix) => [
      `${prefix} public extended identifier`,
      { extendedKeyId: syntheticExtendedKey(prefix) },
    ]),
    ["empty", {}],
    ["null", null],
  ]) {
    assert.doesNotThrow(() => assertNoSecretMaterial(body), `${label}: object-graph scan`);
    assert.doesNotThrow(() => assertSerializedNoSecrets(body), `${label}: serialized-byte scan`);
    const r = sendSim(body);
    assert.equal(r.status, 200, `${label} must not be blocked`);
  }
});

test("the serialized scan returns the exact bytes that will be sent", () => {
  const body = { a: 1, b: "two" };
  assert.equal(assertSerializedNoSecrets(body), JSON.stringify(body));
});
