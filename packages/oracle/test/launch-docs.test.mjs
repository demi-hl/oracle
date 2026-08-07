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

test("Hyperliquid builder-code documentation pins private configuration, fee tiers, and approval units", () => {
  assert.doesNotMatch(HL_BUILDER, /0x[a-fA-F0-9]{40}/);
  assert.match(HL_BUILDER, /Core perpetuals: \*\*2 basis points/i);
  assert.match(HL_BUILDER, /HIP-3: \*\*1 basis point/i);
  assert.match(HL_BUILDER, /HIP-4 outcomes: \*\*1 basis point/i);
  assert.match(HL_BUILDER, /wire values are `20` for core perpetuals and `10` for HIP-3\/HIP-4/i);
  assert.match(HL_BUILDER, /approveBuilderFee/i);
  assert.match(HL_BUILDER, /hyperliquidChain/);
  assert.match(HL_BUILDER, /signatureChainId/);
  assert.match(HL_BUILDER, /main wallet/i);
  assert.match(HL_BUILDER, /maxBuilderFee/i);
  assert.match(HL_BUILDER, /Ownership never changes product access/i);
  assert.match(HL_BUILDER, /including the Oracle builder fee/i);
  assert.match(FEE_WAIVER, /builder fee is also waived/i);
  assert.match(HL_BUILDER, /never signs or submits/i);
  assert.match(README, /hyperliquid-builder-code\.md/);
  assert.match(SETUP, /hyperliquid-builder-code\.md/);
  assert.match(SETUP, /Locals Only holder receives\s+a 0% Oracle rate/i);
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
