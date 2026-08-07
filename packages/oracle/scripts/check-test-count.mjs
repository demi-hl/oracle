#!/usr/bin/env node
// Test-count drift gate.
//
// Two agents push to this branch. Each one runs the suite in its own tree and
// reports a number. Those numbers drift: round 7 landed a commit message
// claiming "707 tests, 0 failing" when the tree at that commit actually ran
// 729. Nobody lied — the claim was just written against a stale checkout, and
// git history keeps it forever.
//
// So the count is committed alongside the code. Add or remove a test and the
// build fails until the baseline is updated in the SAME commit, which puts the
// delta in the diff where review can see it. A stale claim becomes a red build
// instead of a permanent wrong number in the log.
//
//   node scripts/check-test-count.mjs            verify against the baseline
//   node scripts/check-test-count.mjs --update   rewrite it (intentional change)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "test-baseline.json");
const UPDATE = process.argv.includes("--update");

// Run the suite exactly the way `npm test` does, so the gate can never pass
// against a different set of files or env than the suite CI actually runs.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const testCmd = pkg.scripts?.test;
if (!testCmd) {
  console.error("check-test-count: package.json has no test script");
  process.exit(1);
}

const run = spawnSync("sh", ["-c", testCmd], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

const output = `${run.stdout || ""}${run.stderr || ""}`;

// node --test emits two different summary formats. Interactive (TTY) gives the
// spec reporter's "ℹ tests 729". Non-interactive — which is every CI run —
// gives TAP: "# tests 729". Parsing only the first shape passed locally and
// failed in CI, which is the same stale-measurement class this gate exists to
// catch, so match both anchored to line start. A test NAME containing
// "tests 999" lives on an "ok N - ..." line and cannot reach either pattern.
function summaryValue(label) {
  const m = output.match(new RegExp(`^\\s*(?:ℹ|i|#)\\s+${label}\\s+(\\d+)\\s*$`, "m"));
  return m ? Number(m[1]) : null;
}

const actual = {
  tests: summaryValue("tests"),
  pass: summaryValue("pass"),
  fail: summaryValue("fail"),
  skipped: summaryValue("skipped"),
};

if (actual.tests == null || actual.pass == null || actual.fail == null) {
  console.error("check-test-count: could not parse the node --test summary.");
  console.error(output.slice(-2000));
  process.exit(1);
}

// A red suite is the suite step's job to report, but never let a failing run
// silently rewrite the baseline.
if (actual.fail > 0) {
  console.error(`check-test-count: suite is RED (${actual.fail} failing) — refusing to gate or update.`);
  console.error(output.slice(-4000));
  process.exit(1);
}

if (UPDATE) {
  writeFileSync(BASELINE, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`check-test-count: baseline updated -> ${JSON.stringify(actual)}`);
  console.log("Commit test-baseline.json in the same commit as the test change.");
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`check-test-count: ${BASELINE} is missing. Create it with --update.`);
  process.exit(1);
}

const expected = JSON.parse(readFileSync(BASELINE, "utf8"));
const drifted = ["tests", "pass", "fail", "skipped"].filter(
  (k) => Number(expected[k]) !== Number(actual[k]),
);

if (drifted.length) {
  console.error("check-test-count: TEST COUNT DRIFT");
  console.error(`  expected  ${JSON.stringify(expected)}`);
  console.error(`  actual    ${JSON.stringify(actual)}`);
  console.error(`  differs   ${drifted.join(", ")}`);
  console.error("");
  console.error("If this change is intentional, run:");
  console.error("  npm run test:count:update");
  console.error("and commit test-baseline.json alongside the test change.");
  process.exit(1);
}

console.log(`check-test-count: PASS — ${JSON.stringify(actual)} matches the committed baseline`);
