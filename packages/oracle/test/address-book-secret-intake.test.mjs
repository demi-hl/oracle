import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ADDR = "0x" + "ab".repeat(20);

// Values that only LOOK like credentials. Never real key material.
// Built at runtime so no literal key-shaped string is committed — the repo's own
// secret scanner correctly rejects a hardcoded BIP39 phrase in a fixture.
const SYNTHETIC_HEX = "a".repeat(64);
const SYNTHETIC_BIP39 = [
  "abandon", "ability", "able", "about", "above", "absent",
  "absorb", "abstract", "absurd", "abuse", "access", "accident",
].join(" ");

async function withBook(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-ab-"));
  const file = path.join(dir, "address-book.json");
  const saved = process.env.ORACLE_ADDRESS_BOOK;
  process.env.ORACLE_ADDRESS_BOOK = file;
  try {
    const mod = await import(`../src/address-book.mjs?t=${Date.now()}${Math.random()}`);
    return await fn(mod, file);
  } finally {
    if (saved == null) delete process.env.ORACLE_ADDRESS_BOOK;
    else process.env.ORACLE_ADDRESS_BOOK = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The gap: FORBIDDEN_KEYS matched exact names only, so secretKey/seedPhrase/wif
// /keyMaterial/xprv were accepted without error.
test("key-material field aliases are rejected, not silently dropped", async () => {
  await withBook((ab) => {
    for (const field of [
      "secretKey", "seedPhrase", "wif", "keyMaterial", "privKey", "xprv",
      "private_key", "SECRET_KEY", "api_key", "passPhrase", "keystoreJson",
    ]) {
      assert.throws(
        () => ab.rememberAddress({ address: ADDR, [field]: "x" }),
        /forbidden/,
        `${field} must be rejected`,
      );
    }
  });
});

// The worse half: a key-shaped string in an allowed free-text field was stored
// verbatim in plaintext on disk.
test("key-shaped values are refused even under a benign field name", async () => {
  await withBook((ab) => {
    for (const [field, value] of [
      ["notes", SYNTHETIC_HEX],
      ["notes", `0x${SYNTHETIC_HEX}`],
      ["who", SYNTHETIC_BIP39],
      ["role", `xprv${"9".repeat(60)}`],
    ]) {
      assert.throws(
        () => ab.rememberAddress({ address: ADDR, [field]: value }),
        /key material/,
        `${field} carrying a key-shaped value must be rejected`,
      );
    }
  });
});

test("nothing key-shaped ever reaches the persisted file", async () => {
  await withBook((ab, file) => {
    try {
      ab.rememberAddress({ address: ADDR, notes: SYNTHETIC_HEX });
    } catch {
      /* expected */
    }
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    assert.equal(raw.includes(SYNTHETIC_HEX), false, "synthetic key value must not persist");
  });
});

test("nested and array-wrapped secrets are caught", async () => {
  await withBook((ab) => {
    assert.throws(
      () => ab.rememberAddress({ address: ADDR, meta: { deep: { seedPhrase: "x" } } }),
      /forbidden/,
    );
    assert.throws(
      () => ab.rememberAddress({ address: ADDR, meta: [{ notes: SYNTHETIC_HEX }] }),
      /key material/,
    );
  });
});

// The store still has to be usable for its actual purpose.
test("benign labels still store normally", async () => {
  await withBook((ab, file) => {
    ab.rememberAddress({
      address: ADDR,
      label: "my agent",
      who: "DEMI",
      role: "owner",
      notes: "main trading wallet",
    });
    const book = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(book.entries.length, 1);
    assert.equal(book.entries[0].label, "my agent");
    assert.equal(book.entries[0].notes, "main trading wallet");
  });
});

// A bytes32 tx hash and a raw EVM private key are byte-identical, so the 64-hex
// rule must only fire when the WHOLE field is the blob. Rejecting a note that
// merely mentions a tx hash would break ordinary bookkeeping.
test("a hash referenced inside a sentence is not treated as key material", async () => {
  await withBook((ab, file) => {
    ab.rememberAddress({ address: ADDR, notes: `paid via tx 0x${"1".repeat(64)}` });
    const book = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.match(book.entries[0].notes, /^paid via tx 0x/);
  });
});
