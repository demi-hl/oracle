// Name resolution: pure logic and custody posture. No network assertions —
// a venue outage must not turn this suite red. Live resolution was verified
// separately (demi.hl <-> 0x4d47b675…, vitalik.eth <-> 0xd8dA6BF2…).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { namehash, decodeAbiString, ADDRESS_RE, NAME_SOURCES, lookupName, resolveName, toAddress } from "../src/data/names.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "..", "src/data/names.mjs"), "utf8");

test("namehash matches the ENS spec vectors", () => {
  // The canonical fixtures from EIP-137. If this drifts, every lookup silently
  // queries the wrong node and returns "unregistered" instead of failing loudly.
  assert.equal(namehash(""), "0x" + "0".repeat(64));
  assert.equal(namehash("eth"), "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae");
  assert.equal(
    namehash("foo.eth"),
    "0xde9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f",
  );
});

test("decodeAbiString handles empty and zero results as no-name", () => {
  // An unregistered name returns 0x or all-zero rather than reverting, so the
  // empty case is the common path, not an edge case.
  assert.equal(decodeAbiString("0x"), "");
  assert.equal(decodeAbiString(""), "");
  assert.equal(decodeAbiString(null), "");
  assert.equal(decodeAbiString("0x" + "0".repeat(64)), "");
});

test("decodeAbiString reads a real dynamic string", () => {
  const offset = "0000000000000000000000000000000000000000000000000000000000000020";
  const len = "0000000000000000000000000000000000000000000000000000000000000007";
  const body = Buffer.from("demi.hl", "utf8").toString("hex").padEnd(64, "0");
  assert.equal(decodeAbiString("0x" + offset + len + body), "demi.hl");
});

test("address validation rejects near-misses", () => {
  assert.ok(ADDRESS_RE.test("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"));
  assert.ok(!ADDRESS_RE.test("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA960")); // short
  assert.ok(!ADDRESS_RE.test("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045")); // no 0x
  assert.ok(!ADDRESS_RE.test("0xZZZZ6BF26964aF9D7eEd9e03E53415D37aA96045")); // non-hex
});

test("malformed input resolves to null without a network call", async () => {
  assert.equal(await lookupName("not-an-address"), null);
  assert.equal(await lookupName(""), null);
  assert.equal(await lookupName(null), null);
  assert.equal(await resolveName("nodothere"), null);
  assert.equal(await resolveName(""), null);
});

test("toAddress passes a raw address straight through", async () => {
  const addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  const out = await toAddress(addr);
  assert.equal(out.address, addr);
  assert.equal(out.source, "address");
});

test("hyperliquid-native names are tried before ENS", () => {
  // DEMI's primary venue is Hyperliquid, so a wallet holding both .hl and .eth
  // should display the .hl name.
  assert.deepEqual(NAME_SOURCES, ["hl", "hype", "ens", "basename"]);
});

test("resolution is read-only by construction", () => {
  // The module must go through rpcCall(), whose allowlist refuses any non-read
  // method. A direct fetch() to an RPC would bypass that guard entirely.
  assert.match(SRC, /import \{ rpcCall \} from "\.\/providers\/evm-rpc\.mjs"/);
  assert.ok(!/\bfetch\(/.test(SRC), "names.mjs must not open its own RPC transport");
  for (const banned of ["eth_sendTransaction", "eth_sign", "personal_sign", "privateKey"]) {
    assert.ok(!SRC.includes(banned), `names.mjs must not reference ${banned}`);
  }
});

test("a dead RPC degrades to the next source instead of throwing", () => {
  // If .hl lookup throws, .eth must still get a chance; an unreachable
  // HyperEVM endpoint should not take down ENS resolution.
  assert.match(SRC, /catch \{\s*\/\/[\s\S]{0,200}?return null;/);
});

test("HLNames forward resolution uses ownerOf(namehash), not a resolve() helper", () => {
  // Probed the whole plausible surface; only ownerOf(namehash(name)) answers.
  // If someone "simplifies" this to resolve(string) it silently returns null
  // for every .hl name.
  assert.match(SRC, /ownerOf\(uint256\)/);
  assert.match(SRC, /const node = namehash\(name\)/);
});
