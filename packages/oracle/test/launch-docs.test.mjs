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
const FEE_WAIVER = readFileSync(join(DOCS, "locals-only-fee-waiver.md"), "utf8");
const HL_BUILDER = readFileSync(join(DOCS, "hyperliquid-builder-code.md"), "utf8");
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
  assert.doesNotMatch(
    publicOnboarding,
    /verify a Locals Only wallet|short-lived install command|pointer, not the product/i,
  );
});

test("Locals Only documentation is fee-waiver only", () => {
  assert.match(FEE_WAIVER, /Oracle is public to everyone/i);
  assert.match(FEE_WAIVER, /0% Oracle integrator fee/i);
  assert.match(FEE_WAIVER, /does not gate/i);
  assert.doesNotMatch(FEE_WAIVER, /holder-gated|challenge|session token|download link/i);
});

test("Hyperliquid builder-code documentation pins the fee identity and wire units", () => {
  assert.match(HL_BUILDER, /0x4d47B6757aFd42c3dbd9691b71B43d74Afa4b6b2/);
  assert.match(HL_BUILDER, /5 basis points/i);
  assert.match(HL_BUILDER, /[`"]f[`"]\s*[:=]\s*50/i);
  assert.match(HL_BUILDER, /ApproveBuilderFee/i);
  assert.match(HL_BUILDER, /main wallet/i);
  assert.match(HL_BUILDER, /maxBuilderFee/i);
  assert.match(HL_BUILDER, /does not gate|not an access gate/i);
  assert.match(HL_BUILDER, /does not waive (?:the )?Hyperliquid builder fee/i);
  assert.match(FEE_WAIVER, /Hyperliquid builder fee.*not waived/i);
  assert.match(HL_BUILDER, /does not inject|not inject/i);
  assert.match(README, /hyperliquid-builder-code\.md/);
  assert.match(SETUP, /hyperliquid-builder-code\.md/);
  assert.match(SETUP, /waiver does not waive the Hyperliquid builder fee/i);
  assert.doesNotMatch(SETUP, /holder.{0,80}omit|omit.{0,80}builder/i);
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
