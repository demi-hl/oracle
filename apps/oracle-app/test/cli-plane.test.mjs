import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const SOURCE = readFileSync(join(appRoot, "components/oracle/CliPlane.tsx"), "utf8");

/**
 * The CLI plane advertises the CLI. A marketing surface that drifts from
 * the tool it describes is the exact defect class this app was audited for, so
 * the claim is checked against real `oracle --help` output rather than trusted.
 */
function help() {
  return execFileSync(
    process.execPath,
    [join(repoRoot, "packages/oracle/bin/oracle.mjs"), "--help"],
    { encoding: "utf8", timeout: 30_000 },
  );
}

/** Extract the command strings the component renders. */
function advertisedCommands() {
  const block = SOURCE.match(/const HELP_LINES[\s\S]*?\n\];/);
  const signing = SOURCE.match(/const SIGNING_LINES[\s\S]*?\n\];/);
  assert.ok(block && signing, "could not locate the command tables");
  return [...block[0].matchAll(/\["([^"]+)",/g), ...signing[0].matchAll(/\["([^"]+)",/g)].map(
    (m) => m[1],
  );
}

test("every command the CLI plane advertises exists in oracle --help", () => {
  const text = help();
  for (const cmd of advertisedCommands()) {
    assert.ok(
      text.includes(cmd),
      `CLI plane advertises "${cmd}", which oracle --help does not list`,
    );
  }
});

test("every description the CLI plane shows is the CLI's own wording", () => {
  const text = help();
  const details = [...SOURCE.matchAll(/\["[^"]+", "([^"]+)"\]/g)]
    .map((m) => m[1])
    .filter((d) => d !== "");
  assert.ok(details.length >= 8, "expected the plane to carry real help descriptions");
  for (const detail of details) {
    assert.ok(
      text.includes(detail),
      `CLI plane paraphrases the CLI: "${detail}" is not in oracle --help`,
    );
  }
});

test("the advertised install command matches the published package name", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "packages/oracle/package.json"), "utf8"));
  const install = SOURCE.match(/const INSTALL = "([^"]+)"/);
  assert.ok(install, "no install command found");
  assert.ok(
    install[1].includes(pkg.name),
    `install command ${install[1]} does not reference ${pkg.name}`,
  );
  assert.notEqual(pkg.private, true, "advertising install for a private package");
});

test("the CLI plane does not claim the web surface can sign", () => {
  // The CLI is the only client that can reach a signer. The section explains
  // that difference, so it must not blur it back.
  assert.match(SOURCE, /cannot sign/i);
  assert.ok(
    !/this surface can sign|sign from the browser/i.test(SOURCE),
    "CLI plane implies the browser can sign",
  );
});
