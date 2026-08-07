import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ADDR_A = "0x4B7A3D28719d4c0081071d04dEd1F8e102618af8";
const ADDR_B = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";

async function freshBook(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-addr-"));
  fs.chmodSync(dir, 0o700);
  const previous = process.env.ORACLE_ADDRESS_BOOK;
  process.env.ORACLE_ADDRESS_BOOK = path.join(dir, "address-book.json");
  t.after(() => {
    if (previous == null) delete process.env.ORACLE_ADDRESS_BOOK;
    else process.env.ORACLE_ADDRESS_BOOK = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, module: await import(`../src/address-book.mjs?case=${encodeURIComponent(dir)}`) };
}

test("address book is empty and readable before anything is written", async (t) => {
  const { module } = await freshBook(t);
  assert.deepEqual(module.listAddresses(), { updatedAt: null, count: 0, entries: [] });
  assert.equal(module.lookupAddress(ADDR_A).found, false);
});

test("remembering an address persists it with a label and normalized casing", async (t) => {
  const { module } = await freshBook(t);
  const result = module.rememberAddress({ address: ADDR_A, label: "research-agent", who: "Research Agent", role: "agent" });
  assert.equal(result.ok, true);
  assert.equal(result.entry.address, ADDR_A.toLowerCase());
  const found = module.lookupAddress(ADDR_A.toUpperCase().replace("0X", "0x"));
  assert.equal(found.found, true);
  assert.equal(found.entries[0].who, "Research Agent");
});

test("the book file is owner-only on disk", async (t) => {
  const { module } = await freshBook(t);
  module.rememberAddress({ address: ADDR_A, label: "agent" });
  const mode = fs.statSync(module.addressBookPath()).mode & 0o777;
  assert.equal(mode & 0o077, 0, `expected 0600-style mode, got ${mode.toString(8)}`);
});

test("re-remembering the same address and label upserts instead of duplicating", async (t) => {
  const { module } = await freshBook(t);
  module.rememberAddress({ address: ADDR_A, label: "agent", notes: "first" });
  const second = module.rememberAddress({ address: ADDR_A, label: "agent", notes: "second" });
  assert.equal(second.count, 1);
  assert.equal(module.lookupAddress(ADDR_A).entries[0].notes, "second");
});

test("the same address can carry more than one label", async (t) => {
  const { module } = await freshBook(t);
  module.rememberAddress({ address: ADDR_A, label: "research-agent", role: "agent" });
  module.rememberAddress({ address: ADDR_A, label: "research-owner", role: "owner" });
  assert.equal(module.lookupAddress(ADDR_A).entries.length, 2);
});

test("key material is refused outright", async (t) => {
  const { module } = await freshBook(t);
  for (const key of ["privateKey", "mnemonic", "seed", "passphrase"]) {
    assert.throws(
      () => module.rememberAddress({ address: ADDR_A, label: "x", [key]: "should never persist" }),
      /forbidden/,
      `expected ${key} to be refused`,
    );
  }
  assert.equal(module.listAddresses().count, 0);
});

test("malformed addresses are refused", async (t) => {
  const { module } = await freshBook(t);
  for (const bad of ["", "0x", "not-an-address", "0x1234", `${ADDR_A}00`]) {
    assert.throws(() => module.rememberAddress({ address: bad, label: "x" }), /must be 0x/);
  }
});

test("search finds entries by who, label, and free text", async (t) => {
  const { module } = await freshBook(t);
  module.rememberAddress({ address: ADDR_A, label: "research-agent", who: "Research Agent", role: "agent" });
  module.rememberAddress({ address: ADDR_B, label: "lifi-diamond", role: "venue", notes: "bridge router" });
  assert.equal(module.listAddresses({ who: "research" }).count, 1);
  assert.equal(module.listAddresses({ role: "venue" }).count, 1);
  assert.equal(module.listAddresses({ q: "bridge" }).count, 1);
  assert.equal(module.listAddresses().count, 2);
});

test("forget removes one label or the whole address", async (t) => {
  const { module } = await freshBook(t);
  module.rememberAddress({ address: ADDR_A, label: "one" });
  module.rememberAddress({ address: ADDR_A, label: "two" });
  assert.equal(module.forgetAddress(ADDR_A, "one").removed, 1);
  assert.equal(module.lookupAddress(ADDR_A).entries.length, 1);
  assert.equal(module.forgetAddress(ADDR_A).removed, 1);
  assert.equal(module.lookupAddress(ADDR_A).found, false);
});

test("a corrupt book degrades to empty instead of throwing", async (t) => {
  const { module } = await freshBook(t);
  fs.writeFileSync(module.addressBookPath(), "{ not json", { mode: 0o600 });
  assert.equal(module.listAddresses().count, 0);
  assert.equal(module.rememberAddress({ address: ADDR_A, label: "recovered" }).ok, true);
});
