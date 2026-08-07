import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const SETUP = readFileSync(join(ROOT, "SETUP.md"), "utf8");
const CLI = readFileSync(join(DOCS, "cli.md"), "utf8");
const HOLDER = readFileSync(join(DOCS, "holder-beta.md"), "utf8");
const BUZZ = readFileSync(join(DOCS, "buzz-integration.md"), "utf8");
const BUZZ_SOURCE = readFileSync(join(ROOT, "src/public-api/buzz-integration.mjs"), "utf8");

test("public onboarding contains no private operator install or key-provisioning recipe", () => {
  const publicOnboarding = [README, SETUP, CLI].join("\n");
  assert.doesNotMatch(publicOnboarding, /npm i(?:nstall)?\s+(?:-g\s+)?@oracle-agent\/operator/i);
  assert.doesNotMatch(
    publicOnboarding,
    /(?:oracle-vault|HL_PRIVATE_KEY|POLYMARKET_PRIVATE_KEY|ORACLE_VAULT_PASSPHRASE)/,
  );
  assert.match(publicOnboarding, /not published on npm/i);
  assert.match(publicOnboarding, /user(?:'s|-controlled) wallet/i);
});

test("holder-beta doc remains fail-closed until server-side ownership gate exists", () => {
  assert.match(HOLDER, /HOLD for a shared, holder-gated hosted launch/);
  assert.match(HOLDER, /does \*\*not\*\* currently contain an\s+integrated Locals ownership gate/);
  for (const required of [
    "single-use nonce",
    "server recovers the signer",
    "currently owns at least one token",
    "HttpOnly",
    "per-user session",
    "challenge replay denied",
    "ports `8787`, `8799`",
  ]) {
    assert.ok(HOLDER.includes(required), `holder launch gate missing: ${required}`);
  }
});

test("Buzz documentation covers every public endpoint advertised by integration source", () => {
  const paths = new Set(
    [...BUZZ_SOURCE.matchAll(/path:\s*`\$\{base\}(\/public\/[^`]+)`/g)].map((match) => match[1]),
  );
  assert.ok(paths.size >= 10, `expected Buzz source endpoint catalog, got ${paths.size}`);
  for (const path of paths) {
    assert.ok(BUZZ.includes(path), `Buzz documentation omits ${path}`);
  }
  assert.match(BUZZ, /does not create a persistent Oracle chat session/i);
  assert.match(BUZZ, /not \*\*“Oracle chat is integrated into Buzz/i);
});
