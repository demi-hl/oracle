// Does the artifact id actually bind? A link minted for the CLI must not fetch
// the desktop build.
//
// This mirrors the gate's signing scheme rather than importing it, because
// oracle-gate-server.mjs starts an HTTP listener on import. The shape is
// asserted against the real file below so the two cannot drift silently.
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

const SECRET = "test-secret";
function signDownload(address, expiresAt, artifact = "cli") {
  return createHmac("sha256", SECRET)
    .update(`${address.toLowerCase()}.${expiresAt}.${artifact}`)
    .digest("base64url");
}

const addr = "0x4d47b6757afd42c3dbd9691b71b43d74afa4b6b2";
const exp = Date.now() + 60000;

test("a link minted for one artifact cannot fetch another", () => {
  const cliSig = signDownload(addr, exp, "cli");
  const linuxSig = signDownload(addr, exp, "linux");
  assert.notEqual(cliSig, linuxSig);
  // Swapping the artifact param invalidates the HMAC.
  assert.notEqual(signDownload(addr, exp, "linux"), cliSig);
});

test("a link minted for one holder cannot be reused by another", () => {
  const other = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  assert.notEqual(signDownload(other, exp, "linux"), signDownload(addr, exp, "linux"));
});

test("changing the deadline invalidates the signature", () => {
  assert.notEqual(signDownload(addr, exp + 1, "linux"), signDownload(addr, exp, "linux"));
});

test("address case does not matter, the signer lowercases it", () => {
  assert.equal(signDownload(addr.toUpperCase(), exp, "linux"), signDownload(addr, exp, "linux"));
});

test("the gate really signs address.expires.artifact", async () => {
  // Guard against drift: if the server's scheme changes, this fails loudly
  // instead of leaving the tests above asserting a fiction.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const src = await readFile(
    fileURLToPath(new URL("../bin/oracle-gate-server.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(src, /\.update\(`\$\{address\.toLowerCase\(\)\}\.\$\{expiresAt\}\.\$\{artifact\}`\)/);
  // And the download route must verify the artifact it was asked for.
  assert.match(src, /verifyDownload\(address, expiresAt, sig, artifactId\)/);
});
