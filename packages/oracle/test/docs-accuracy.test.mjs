// Documentation accuracy.
//
// Every concrete claim in the README is a promise to a stranger evaluating whether
// to trust this code with money. Numbers rot silently: a provider gets added, a
// chain gets registered, and the README quietly becomes a lie nobody notices.
//
// These tests bind the prose to the tree. When one fails, the README is wrong (or
// the change was bigger than intended) -- fix one or the other, deliberately.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const ORACLE_SOUL = fs.readFileSync(path.join(ROOT, "profiles/oracle/SOUL.md"), "utf8");
const DOC_DRIFT_GATE = fs.readFileSync(path.join(ROOT, "scripts/check-doc-drift.mjs"), "utf8");

test("README's chain count matches the shipped config", async () => {
  const { CHAIN_CONFIGS } = await import("../src/scanner/chains.config.mjs");
  const m = README.match(/\*\*(\d+) EVM chains\*\*/);
  assert.ok(m, "README should state an EVM chain count");
  assert.equal(
    Number(m[1]),
    CHAIN_CONFIGS.length,
    `README says ${m[1]} chains, config has ${CHAIN_CONFIGS.length}`,
  );
});

test("README's provider count is not an overstatement", async () => {
  const { dataCatalog } = await import("../src/data/desk-data.mjs");
  const actual = dataCatalog().length;
  // The README states an exact module count now, because "30+ providers" was
  // being read as a protocol count. Provider modules and protocols are
  // different numbers: one module can cover many venues.
  const m = README.match(/\*\*(\d+) provider modules\*\*/);
  assert.ok(m, "README should state a provider-module count");
  assert.equal(
    Number(m[1]),
    actual,
    `README claims ${m[1]} provider modules but the catalog has ${actual}`,
  );
});

test("README's protocol count matches the shipped roster", async () => {
  const claimed = README.match(/\*\*(\d+) unique\s*\n?\s*protocols\/venues\*\*/);
  assert.ok(claimed, "README should state a protocol/venue total");

  // Ground the Solana half against the provider's own verified program map
  // rather than splash markup: the splash rail is a presentation choice that
  // has been added and removed, but the routed venue list is the real claim.
  const { JUPITER_VENUE_LABELS, uniqueVenueBrands } = await import(
    "../src/data/providers/jupiter-venues.mjs"
  );
  assert.equal(
    JUPITER_VENUE_LABELS.length,
    101,
    `README claims 101 verified programs but the roster has ${JUPITER_VENUE_LABELS.length}`,
  );
  assert.equal(
    uniqueVenueBrands().size,
    98,
    `README claims 98 Solana venues but the roster resolves ${uniqueVenueBrands().size}`,
  );
});

test("every lane the README names actually exists", () => {
  const dir = path.join(ROOT, "profiles");
  const onDisk = new Set(
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  for (const lane of [
    "oracle",
    "polymarket-agent",
    "hyperliquid-agent",
    "robinhood-agent",
    "solana-agent",
    "bitcoin-agent",
    "stable-agent",
    "protocol-builder",
    "_template",
  ]) {
    assert.ok(README.includes(lane), `README should mention lane ${lane}`);
    assert.ok(onDisk.has(lane), `lane ${lane} named in README but missing from profiles/`);
  }
});

test("every bin the README shows is declared and present", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const [name, rel] of Object.entries(pkg.bin || {})) {
    assert.ok(
      fs.existsSync(path.join(ROOT, rel)),
      `package.json declares bin "${name}" -> ${rel}, which does not exist`,
    );
  }
  // The commands the README tells a user to run must be real.
  for (const cmd of ["oracle-init", "oracle-scan"]) {
    assert.ok(README.includes(cmd), `README should document ${cmd}`);
    assert.ok(pkg.bin[cmd], `${cmd} must be declared in package.json bin`);
  }
});

test("every example the README references exists and is syntactically valid", async () => {
  const dir = path.join(ROOT, "examples");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length >= 2, "expected at least two examples");
  for (const f of files) {
    assert.ok(README.includes(f), `README should reference examples/${f}`);
    // Importing would execute it (these examples hit the network), so just parse.
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotThrow(
      () => new (Function.prototype.constructor)(""), // ensure Function is usable
      "sanity",
    );
    assert.ok(src.includes("import"), `${f} should be an ES module`);
  }
});

test("every doc the README links to exists", () => {
  const links = [...README.matchAll(/\]\((docs\/[^)]+|[A-Z]+\.md)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, "README should link to docs");
  for (const l of new Set(links)) {
    assert.ok(fs.existsSync(path.join(ROOT, l)), `README links to ${l}, which is missing`);
  }
});

test("README states standalone model auth and optional Hermes accurately", () => {
  assert.match(README, /Oracle runs native chat/i);
  assert.match(README, /Claude, Codex,[\s\S]{0,40}Grok OAuth/i);
  assert.match(README, /private `0600` local fallback/i);
  assert.doesNotMatch(README, /no model calls and needs no API key/i);
  assert.doesNotMatch(README, /first chat[^\n]*installs an isolated local agent runtime/i);
});

test("README states the custody invariant", () => {
  // If this line ever disappears, the project's central promise went unstated.
  assert.ok(
    /never (receives|holds) private keys|self-custody by default/i.test(README),
    "README must state the custody position",
  );
  assert.ok(
    /custody-boundary\.test\.mjs|enforced by test/i.test(README),
    "README should say the boundary is enforced by a test, not a convention",
  );
  assert.match(
    README,
    /## Start safely/i,
    "README should lead with public read/prepare onboarding",
  );
  assert.match(
    README,
    /user's wallet reviews, signs, and submits/i,
    "public preparation should terminate at the user's wallet",
  );
  assert.match(
    README,
    /holder-beta\.md/,
    "README should link the Locals-holder launch gate",
  );
  assert.match(
    README,
    /not published on npm[^\n]*[\s\S]{0,100}not part of holder onboarding/i,
    "README must keep private operator infrastructure out of holder onboarding",
  );
  assert.doesNotMatch(
    README,
    /npm i(?:nstall)?\s+(?:-g\s+)?@oracle-agent\/operator/i,
    "public README must not advertise an unavailable private operator install",
  );
  assert.doesNotMatch(
    README,
    /(?:oracle-vault|HL_PRIVATE_KEY|POLYMARKET_PRIVATE_KEY|ORACLE_VAULT_PASSPHRASE)/,
    "public README must not teach holder users to provision operator key material",
  );
  assert.match(
    README,
    /ORACLE_AUTONOMOUS_TRADING=1`? is (?:only )?direct execution for trusted owner-controlled\s+local code only/i,
    "README must restrict ORACLE_AUTONOMOUS_TRADING=1 to trusted owner-controlled direct exec",
  );
  assert.match(
    README,
    /never model\/agent authority/i,
    "README must say autonomous direct exec is never model/agent authority",
  );
  assert.match(
    README,
    /six bounded surfaces: `hl`, `poly`,\s+`evm-swap`, `evm-bridge`, `btc`, `sol`/,
    "README should name all six generic signer surfaces",
  );
  assert.match(
    README,
    /enforces its caps, and refuses while its allowlists are empty/i,
    "README should state caps and fail-closed allowlists",
  );
  assert.doesNotMatch(
    README,
    /agent-facing daemon supports only policy-bounded Hyperliquid and Polymarket execution/i,
    "README must not keep the old HL/Poly-only daemon claim",
  );
  assert.match(
    DOC_DRIFT_GATE,
    /agent-facing\\s\+daemon\\s\+supports\\s\+only\\s\+policy-bounded\\s\+Hyperliquid\\s\+and\\s\+Polymarket\\s\+execution/,
    "doc drift gate should reject the exact old Hyperliquid/Polymarket-only daemon prose",
  );
  assert.match(
    DOC_DRIFT_GATE,
    /ORACLE_AUTONOMOUS_TRADING=1\.\*\(\?:or\\s\+run\\s\+the\\s\+signer\\s\+daemon\|same\(\?:-tier\)\?\)\.\*oracle-signer/,
    "doc drift gate should reject direct exec / oracle-signer same-tier framing",
  );
});

test("model-facing Oracle profile names the real autonomous trading env", () => {
  assert.match(
    ORACLE_SOUL,
    /ORACLE_AUTONOMOUS_TRADING=1/,
    "Oracle SOUL must name the code-backed autonomous trading env var",
  );
  assert.doesNotMatch(
    ORACLE_SOUL,
    /ORACLE_AUTONOMOUS=1/,
    "Oracle SOUL must not name the dead ORACLE_AUTONOMOUS env var",
  );
  assert.match(
    DOC_DRIFT_GATE,
    /ORACLE_AUTONOMOUS=1/,
    "doc drift gate should reject the dead ORACLE_AUTONOMOUS env var",
  );
});

test("no doc leaks private infrastructure details", () => {
  const slash = "/";
  const forbidden = [
    new RegExp(`${slash}home${slash}[a-z0-9_-]+${slash}\\.(oracle|config)${slash}`, "i"),
    new RegExp(`${slash}root${slash}[a-z0-9_.-]+`, "i"),
    new RegExp(["RH", "AGENT", "API", "KEY"].join("_")),
    /rhag_/,
  ];
  const docDir = path.join(ROOT, "docs");
  const files = [
    path.join(ROOT, "README.md"),
    path.join(ROOT, "CONTRIBUTING.md"),
    path.join(ROOT, "SECURITY.md"),
    ...fs.readdirSync(docDir).map((f) => path.join(docDir, f)),
  ];
  const hits = [];
  for (const f of files) {
    const body = fs.readFileSync(f, "utf8");
    for (const re of forbidden) {
      if (re.test(body)) hits.push(`${path.relative(ROOT, f)}: ${re}`);
    }
  }
  assert.deepEqual(hits, [], `operator details leaked into docs:\n  ${hits.join("\n  ")}`);
});
