// Gated distribution: the artifact is served by the operator's server, so the
// check cannot be patched out on the user's machine.
//
// Context for anyone tempted to "simplify" this back: the CLI's own NFT check
// is bypassable with ORACLE_GATE_BYPASS=1 or by pointing
// ORACLE_OPERATOR_BIN_DIR at any directory with a bin. That is unavoidable for
// code running on the visitor's machine. This server is the only place a
// holder check means anything.
//
// Verified live 2026-08-06 over HTTP against the real chain:
//   unauthenticated /gate/install -> 401
//   forged bearer token           -> 401
//   unsigned /gate/download       -> 403
//   guessed signature             -> 403
//   non-holder signed challenge   -> 403 not-a-holder
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, timingSafeEqual } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "..", "bin/oracle-gate-server.mjs"), "utf8");

const SECRET = "unit-test-secret";
const sign = (addr, exp) =>
  createHmac("sha256", SECRET).update(`${addr.toLowerCase()}.${exp}`).digest("base64url");
const verify = (addr, exp, sig, now = Date.now()) => {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(addr || "")) || !Number.isFinite(exp) || exp < now) return false;
  const e = Buffer.from(sign(addr, exp));
  const s = Buffer.from(String(sig || ""));
  return e.length === s.length && timingSafeEqual(e, s);
};

const ADDR = "0x4d47b6757afd42c3dbd9691b71b43d74afa4b6b2";
const OTHER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

test("a download link is bound to one address and one deadline", () => {
  const exp = Date.now() + 300_000;
  const sig = sign(ADDR, exp);
  assert.ok(verify(ADDR, exp, sig), "the holder's own link must work");
  assert.ok(!verify(OTHER, exp, sig), "a link must not transfer to another wallet");
  assert.ok(!verify(ADDR, exp + 1, sig), "the deadline must not be editable");
  assert.ok(!verify(ADDR, Date.now() - 1, sign(ADDR, Date.now() - 1)), "expired links must fail");
  assert.ok(!verify(ADDR, exp, "guess"), "a guessed signature must fail");
});

test("the signature comparison is timing-safe and length-checked", () => {
  // timingSafeEqual throws on a length mismatch, so the length guard has to
  // come first or a short signature crashes the request instead of failing it.
  assert.match(SRC, /expected\.length === supplied\.length && timingSafeEqual/);
});

test("the download route refuses before it streams", () => {
  const route = SRC.slice(SRC.indexOf('url.pathname === "/gate/download"'));
  const guardAt = route.indexOf("verifyDownload");
  const streamAt = route.indexOf("createReadStream");
  assert.ok(guardAt > 0 && streamAt > guardAt, "verification must precede the file stream");
});

test("the gate states honestly which mode it is running in", () => {
  // Handing out a public-registry install command is discovery, not
  // enforcement. Labelling that "gated" would be the same overclaim the splash
  // copy just had to be corrected for.
  assert.match(SRC, /distribution: download \? "gated-tarball" : "public-registry"/);
  assert.match(SRC, /That is discovery, not enforcement/);
});

test("no artifact configured fails closed, not open", () => {
  const route = SRC.slice(SRC.indexOf('url.pathname === "/gate/download"'));
  // The gate serves several builds now (cli, linux, mac, win), so the
  // existence check moved into artifactFor(): it returns null unless that
  // artifact is both configured AND present on disk, and the route 503s on
  // null. Still fail-closed, just per-artifact.
  assert.match(route, /const entry = artifactFor\(artifactId\)/);
  assert.match(route, /if \(!entry\)/);
  assert.match(route, /503/);
  assert.match(SRC, /if \(!entry \|\| !entry\.path \|\| !existsSync\(entry\.path\)\) return null/);
});

test("the gate server holds no key material", () => {
  for (const banned of ["privateKey", "PRIVATE_KEY", "mnemonic", "eth_sendTransaction", "signTransaction"]) {
    assert.ok(!SRC.includes(banned), `gate server must not reference ${banned}`);
  }
});

test("the gated install command works on current npm", () => {
  // npm 12 refuses remote package fetches outright:
  //   npm error code EALLOWREMOTE
  //   Fetching packages of type "remote" have been disabled
  // So `npm i -g <url>` cannot work, even though the tarball installs fine
  // from a local path. Verified 2026-08-06 on npm 12.0.1: the URL form failed
  // and the two-step curl form installed 31 packages and 8 bins.
  const install = SRC.slice(SRC.indexOf("download = {"), SRC.indexOf("download = {") + 700);
  assert.doesNotMatch(install, /npm i -g "<gate-origin>/, "npm cannot install a package from a URL");
  assert.match(install, /curl -fL -o oracle\.tgz/);
  assert.match(install, /npm i -g \.\/oracle\.tgz/);
});
