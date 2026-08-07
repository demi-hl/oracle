import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { entropyToMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

const here = path.dirname(fileURLToPath(import.meta.url));
const scanner = path.resolve(here, "../scripts/secret-scan.mjs");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function initRepo(repo, email = "oracle@users.noreply.github.com") {
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Oracle"]);
  git(repo, ["config", "user.email", email]);
}

test("history scanner catches and redacts a checksum-valid mnemonic from the full BIP-39 list", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-secret-scan-"));
  const mnemonic = entropyToMnemonic(new Uint8Array(16).fill(128), wordlist);
  assert.equal(validateMnemonic(mnemonic, wordlist), true);

  initRepo(repo);
  fs.writeFileSync(path.join(repo, "leak.txt"), `${mnemonic}\n`);
  git(repo, ["add", "leak.txt"]);
  git(repo, ["commit", "-qm", "fixture"]);

  const result = spawnSync(process.execPath, [scanner], { cwd: repo, encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /BIP39 seed phrase/);
  assert.equal(output.includes(mnemonic), false);
});

test("history scanner rejects non-public git identities without printing the address", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-secret-identity-"));
  const privateEmail = "founder@example.gmail.com";
  initRepo(repo, privateEmail);
  fs.writeFileSync(path.join(repo, "safe.txt"), "safe\n");
  git(repo, ["add", "safe.txt"]);
  git(repo, ["commit", "-qm", "fixture"]);

  const result = spawnSync(process.execPath, [scanner], { cwd: repo, encoding: "utf8" });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /non-public git identity/);
  assert.equal(output.includes(privateEmail), false);

  const publicRepo = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-public-identity-"));
  initRepo(publicRepo, "noreply@github.com");
  fs.writeFileSync(path.join(publicRepo, "safe.txt"), "safe\n");
  git(publicRepo, ["add", "safe.txt"]);
  git(publicRepo, ["commit", "-qm", "fixture"]);
  const publicResult = spawnSync(process.execPath, [scanner], { cwd: publicRepo, encoding: "utf8" });
  assert.equal(publicResult.status, 0, `${publicResult.stdout}\n${publicResult.stderr}`);
});
