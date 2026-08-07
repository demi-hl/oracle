import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanner = path.join(packageRoot, "scripts/secret-scan.mjs");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("secret scanner resolves the git root when npm runs it from the package", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-secret-cwd-"));
  const nestedPackage = path.join(repo, "packages", "oracle");
  fs.mkdirSync(nestedPackage, { recursive: true });
  fs.writeFileSync(path.join(repo, "safe.txt"), "safe\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Oracle"]);
  git(repo, ["config", "user.email", "oracle@users.noreply.github.com"]);
  git(repo, ["add", "safe.txt"]);
  git(repo, ["commit", "-qm", "fixture"]);

  const env = { ...process.env };
  delete env.ORACLE_ROUTE_ATTESTATION_SECRET;
  const result = spawnSync(process.execPath, [scanner], {
    cwd: nestedPackage,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /fatal: path .* is in the index, but not/);
  assert.match(output, /PASS — no secrets found in tree or history/);
});
