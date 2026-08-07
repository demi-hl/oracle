// Portability: the shipped tree must not assume the author's machine.
//
// This is the class of bug that never fails for the person who wrote it and fails
// for literally everyone else. Three attestation modules shipped with
// an absolute operator-home config path as a fallback -- harmless on one
// author's box, broken and environment-leaking anywhere else.
//
// Runtime code is held to a stricter standard than tests, which legitimately use
// operator-shaped strings as NEGATIVE fixtures (asserting the secret scanner blocks
// them).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every shipped runtime file (src/ + bin/), excluding tests. */
function runtimeFiles() {
  const out = [];
  for (const dir of ["src", "bin"]) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".mjs") || e.name.endsWith(".js")) out.push(full);
      }
    };
    walk(base);
  }
  return out;
}

/** Strip comments so prose explaining a rule does not trip the rule. */
function codeOf(file) {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("no runtime file hardcodes a user home directory", () => {
  const hits = [];
  for (const f of runtimeFiles()) {
    const code = codeOf(f);
    // Absolute paths into somebody's home. homedir()-derived joins are fine.
    const slash = "/";
    const homes = [
      new RegExp(`["'\\\`]${slash}home${slash}[a-z0-9_-]+`, "i"),
      new RegExp(`["'\\\`]${slash}Users${slash}[a-z0-9_-]+`, "i"),
      new RegExp(`["'\\\`]${slash}root${slash}`, "i"),
    ];
    for (const re of homes) {
      if (re.test(code)) hits.push(`${path.relative(ROOT, f)} :: ${re}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `runtime code must derive paths from os.homedir(), not a baked-in home:\n  ${hits.join("\n  ")}`,
  );
});

test("no runtime file references the private repo's infrastructure", () => {
  const hits = [];
  for (const f of runtimeFiles()) {
    const code = codeOf(f);
    const privateApiEnv = new RegExp(["RH", "AGENT", "API", "KEY"].join("_"));
    for (const re of [/private-hostname-placeholder/i, privateApiEnv, /multiagent-desk/i]) {
      if (re.test(code)) hits.push(`${path.relative(ROOT, f)} :: ${re}`);
    }
  }
  assert.deepEqual(hits, [], `private infrastructure leaked into runtime code:\n  ${hits.join("\n  ")}`);
});

test("attestation secret resolution is shared, not copy-pasted", () => {
  // Three near-identical copies had drifted, each carrying the same hardcoded path.
  // Duplication is how one fix silently misses two call sites.
  const helper = path.join(ROOT, "src", "attestation-secret.mjs");
  assert.ok(fs.existsSync(helper), "expected a shared attestation secret helper");

  for (const name of ["route", "vault", "gmx"]) {
    const f = path.join(ROOT, "src", `${name}-attestation.mjs`);
    if (!fs.existsSync(f)) continue;
    const code = codeOf(f);
    assert.match(
      code,
      /resolveAttestationSecret/,
      `${name}-attestation.mjs should use the shared resolver`,
    );
    assert.ok(
      !/readFileSync\(/.test(code),
      `${name}-attestation.mjs should not re-implement env-file reading`,
    );
  }
});

test("the attestation resolver fails closed with an actionable message", async () => {
  const { resolveAttestationSecret } = await import("../src/attestation-secret.mjs");

  // Present in env -> returned.
  process.env.__ORACLE_TEST_SECRET = "s3cret";
  assert.equal(
    resolveAttestationSecret(undefined, "__ORACLE_TEST_SECRET", "__ORACLE_TEST_LEGACY"),
    "s3cret",
  );
  delete process.env.__ORACLE_TEST_SECRET;

  // Legacy name still honoured, so existing deployments keep working.
  process.env.__ORACLE_TEST_LEGACY = "legacy";
  assert.equal(
    resolveAttestationSecret(undefined, "__ORACLE_TEST_SECRET", "__ORACLE_TEST_LEGACY"),
    "legacy",
  );
  delete process.env.__ORACLE_TEST_LEGACY;

  // Explicit argument wins over both.
  assert.equal(
    resolveAttestationSecret("explicit", "__ORACLE_TEST_SECRET", "__ORACLE_TEST_LEGACY"),
    "explicit",
  );

  // Absent everywhere -> throw, and the message must say how to fix it. Minting an
  // unsigned attestation instead would defeat the entire control.
  assert.throws(
    () =>
      resolveAttestationSecret(
        undefined,
        "__ORACLE_DEFINITELY_UNSET_PRIMARY",
        "__ORACLE_DEFINITELY_UNSET_LEGACY",
      ),
    /required for attestation.*exec\.env/s,
  );
});

test("live-network tests are opt-in and use an ORACLE_-prefixed flag", () => {
  // A contributor running the suite offline must get a clean pass, not a red suite
  // caused by someone else's rate limit.
  const f = path.join(ROOT, "test", "data-live.test.mjs");
  if (!fs.existsSync(f)) return;
  const body = fs.readFileSync(f, "utf8");
  assert.match(body, /ORACLE_LIVE_DATA/, "the documented flag should be ORACLE_-prefixed");
  assert.match(body, /skip: !live/, "live tests must be skipped by default");
});
