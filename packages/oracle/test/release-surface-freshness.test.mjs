import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverCommands } from "../src/cli/kernel.mjs";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PACKAGE, "../..");
const read = (path) => readFileSync(path, "utf8");

const rootReadme = read(join(ROOT, "README.md"));
const rootSetup = read(join(ROOT, "SETUP.md"));
const packageReadme = read(join(PACKAGE, "README.md"));
const packageSetup = read(join(PACKAGE, "SETUP.md"));
const cliDocs = read(join(PACKAGE, "docs/cli.md"));
const publicSurface = read(join(PACKAGE, "docs/public-surface.md"));
const feeWaiver = read(join(PACKAGE, "docs/locals-only-fee-waiver.md"));
const contributing = read(join(ROOT, "CONTRIBUTING.md"));
const splash = read(join(PACKAGE, "public/oracle-splash/index.html"));
const downloads = read(join(PACKAGE, "public/oracle-splash/downloads/index.html"));
const distSmoke = read(join(PACKAGE, "scripts/smoke-dist-bins.mjs"));
const notarizeMac = read(join(ROOT, "apps/oracle-desktop/scripts/notarize-mac.mjs"));

const publicDocs = [rootReadme, rootSetup, packageReadme, packageSetup, cliDocs];
const retiredGateLanguage = /holder-gated|distributed to Locals Only holders|prove (?:wallet )?ownership|oracle gate|ORACLE_GATE_|\/gate\/(?:challenge|verify|install|download)|access requires a Locals Only/i;

test("public docs install the full npm package without a holder gate", () => {
  for (const body of publicDocs) {
    assert.match(body, /npm (?:i|install) -g @oracle-agent\/oracle/);
    assert.doesNotMatch(body, retiredGateLanguage);
  }
  assert.doesNotMatch(publicSurface, retiredGateLanguage);
});

test("Locals Only documentation is fee-only and explicitly public-access", () => {
  assert.match(feeWaiver, /0% Oracle integrator fee/i);
  assert.match(feeWaiver, /does not gate (?:Oracle )?(?:downloads|access)/i);
  assert.match(feeWaiver, /source/i);
  assert.match(feeWaiver, /CLI/i);
  assert.match(feeWaiver, /desktop/i);
});

test("the public download page exposes ordinary links with no wallet flow", () => {
  assert.match(downloads, /npm i -g @oracle-agent\/oracle/);
  assert.match(downloads, /href="\/downloads\/artifacts\/Oracle-0\.2\.0\.AppImage"/);
  assert.match(downloads, /href="\/downloads\/artifacts\/Oracle-0\.2\.0-arm64\.dmg"/);
  assert.match(downloads, /href="\/downloads\/artifacts\/Oracle-Setup-0\.2\.0\.exe"/);
  assert.doesNotMatch(downloads, retiredGateLanguage);
  assert.doesNotMatch(downloads, /window\.ethereum|personal_sign|Connect wallet/i);
});

test("the download page binds displayed checksums to the hosted manifest", () => {
  assert.match(downloads, /fetch\("\/downloads\/artifacts\/SHA256SUMS\.txt"/);
  assert.match(downloads, /data-artifact="Oracle-0\.2\.0\.AppImage"/);
  assert.match(downloads, /data-artifact="Oracle-0\.2\.0-arm64\.dmg"/);
  assert.match(downloads, /data-artifact="Oracle-Setup-0\.2\.0\.exe"/);
  assert.match(downloads, /checksum unavailable/i);
});

test("the homepage is indexable and routes every download CTA to the public page", () => {
  assert.match(splash, /<meta name="robots" content="index,follow"\s*\/>/);
  assert.match(splash, /href="\/downloads\/"/);
  assert.match(splash, /href="\/downloads\/#desktop"/);
  assert.doesNotMatch(splash, /releases\/download|holder-gated|holders receive gated/i);
  assert.doesNotMatch(splash, /trigger:\s*"#protocols"/);
});

test("provider, chain, CLI target, and test-count copy matches runtime", () => {
  for (const body of [rootReadme, packageReadme]) {
    assert.match(body, /70 provider modules/);
    assert.match(body, /All 11 built-in EVM chains/);
    assert.doesNotMatch(body, /42 provider modules|8 of 11 chains ship verified venues/);
  }
  assert.doesNotMatch(cliDocs, /mcp install hermes/);
  assert.match(cliDocs, /mcp install (?:claude|claude-code)/);
  assert.match(cliDocs, /mcp install codex/);
  assert.match(cliDocs, /mcp install cursor/);
  assert.doesNotMatch(contributing, /391 tests/);
});

test("every command advertised by root help is discoverable", async () => {
  const commands = await discoverCommands();
  assert.equal(commands.has("harness"), true);
  assert.equal(commands.has("fees"), true);
});

test("distribution smoke covers fees and never invokes the retired gate command", () => {
  assert.match(distSmoke, /\["fees", \["fees", "status"\]/);
  assert.doesNotMatch(distSmoke, /\["gate", \["gate"/);
});

test("mac notarization assesses the mounted app instead of the DMG container", () => {
  assert.match(notarizeMac, /"attach", "-nobrowse", "-readonly", "-mountpoint"/);
  assert.match(notarizeMac, /"--type", "execute"/);
  assert.match(notarizeMac, /Notarized Developer ID/);
  assert.doesNotMatch(notarizeMac, /--type open/);
  assert.match(notarizeMac, /finally\s*{/);
  assert.match(notarizeMac, /"detach", mountPoint/);
  assert.match(notarizeMac, /rmSync\(mountPoint, \{ recursive: true, force: true \}\)/);
});
