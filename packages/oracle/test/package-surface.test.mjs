// Public package/API surface gates for open-source release.
//
// These catch the class of issue `npm test` missed: the repo worked internally,
// but public package consumers got missing exports or docs that imported symbols
// from the wrong package subpath.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
// Standalone package keeps package-lock.json next to package.json. The public
// monorepo keeps one root lockfile and stores this workspace under packages/oracle.
const lockCandidates = [
  path.join(ROOT, "package-lock.json"),
  path.resolve(ROOT, "../../package-lock.json"),
];
const lockPath = lockCandidates.find((candidate) => fs.existsSync(candidate));
assert.ok(lockPath, "package-lock.json must exist next to the package or monorepo root");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const lockPackage =
  lock.packages?.["packages/oracle"] ||
  lock.packages?.[""] ||
  null;
assert.ok(lockPackage, "package-lock must contain packages/oracle or root package metadata");

test("package allowlist excludes generated Python bytecode", () => {
  assert.ok(pkg.files.includes("!src/**/__pycache__/**"));
});

test("repository does not track generated release archives", () => {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const tracked = execFileSync(
    "git",
    ["ls-files", "-z", "*.tgz", "*.tar.gz", "*.zip", "*.bundle"],
    { cwd: repoRoot, encoding: "utf8" },
  ).split("\0").filter(Boolean);
  assert.deepEqual(tracked, []);
});

function absPackageTarget(target) {
  return path.join(ROOT, String(target).replace(/^\.\//, ""));
}

test("every package export target exists and imports", async () => {
  const failures = [];
  for (const [name, target] of Object.entries(pkg.exports || {})) {
    const abs = absPackageTarget(target);
    if (!fs.existsSync(abs)) {
      failures.push(`${name} -> ${target} is missing`);
      continue;
    }
    try {
      await import(`${abs}?surface=${encodeURIComponent(name)}`);
    } catch (error) {
      failures.push(`${name} -> ${target} failed import: ${String(error?.message || error).slice(0, 200)}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("README documented package imports resolve to exported symbols", async () => {
  // Self-reference import uses package.json exports exactly like an installed
  // consumer does, without needing to create a tarball on every test run.
  const scanner = await import(`${pkg.name}/scanner`);
  assert.equal(typeof scanner.registerCustomChain, "function");
  assert.equal(typeof scanner.registerBuiltinScanners, "function");
  assert.equal(typeof scanner.validateScanner, "function");

  const semantics = await import(`${pkg.name}/action-semantics`);
  assert.equal(semantics.actionModeForVerb("watch"), "alert_only");
  assert.equal(semantics.actionModeForVerb("arm"), "execute");

  const root = await import(pkg.name);
  for (const name of [
    "dataCall",
    "dataCatalog",
    "registerCustomChain",
    "createScanner",
    "validateNftMintGasWar",
    "assertNftMintGasWar",
    "actionModeForVerb",
    "assertActionRecord",
    "migrateLegacyWatchRecord",
    "emitHarnessConfigs",
    "normalizeActionReceipt",
    "summarizePortfolioRisk",
    "defaultPreferences",
    "scoreSignals",
  ]) {
    assert.equal(typeof root[name], "function", `root export should include ${name}`);
  }

  const connect = await import(`${pkg.name}/connect`);
  assert.equal(typeof connect.emitHarnessConfigs, "function");
  const receipts = await import(`${pkg.name}/receipts`);
  assert.equal(typeof receipts.normalizeActionReceipt, "function");
  const risk = await import(`${pkg.name}/risk`);
  assert.equal(typeof risk.summarizePortfolioRisk, "function");
  const watch = await import(`${pkg.name}/watch`);
  assert.equal(typeof watch.defaultPreferences, "function");
  const signals = await import(`${pkg.name}/signals`);
  assert.equal(typeof signals.scoreSignals, "function");
});

test("package metadata cannot drift from shipped public surface", () => {
  assert.deepEqual(
    Object.keys(lockPackage.bin || {}).sort(),
    Object.keys(pkg.bin || {}).sort(),
    "package-lock bin entries must match package.json",
  );
  assert.match(pkg.engines?.node || "", />=20\.19\.0/, "Node engine must satisfy @noble dependency floor");
  assert.ok((pkg.files || []).includes("examples/"), "README-referenced examples must ship in npm package files allowlist");
});
