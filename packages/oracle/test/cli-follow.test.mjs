// `oracle follow` -- the CLI surface over the wallet scanner.
//
// Verified live 2026-08-06: `oracle follow vitalik.eth --blocks 20000` printed
// 149 transfers, `--blocks 2000` printed 4. That difference is the regression
// this file exists to protect: the scanner's option is `lookback`, and the
// first version of this command passed `lookbackBlocks`, so --blocks was
// silently dropped and every query used the 100k default.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import follow from "../src/cli/commands/follow.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "..", "src/cli/commands/follow.mjs"), "utf8");

test("the command registers with the shape the CLI loader expects", () => {
  assert.equal(follow.name, "follow");
  assert.equal(typeof follow.run, "function");
  assert.ok(follow.summary && follow.summary.length > 0);
  assert.ok(follow.usage && follow.usage.includes("oracle follow"));
});

test("--blocks is passed as `lookback`, the option the scanner actually reads", () => {
  // Passing `lookbackBlocks` here type-checks fine and silently does nothing.
  assert.match(SRC, /lookback: lookbackBlocks/);
  assert.doesNotMatch(SRC, /\blookbackBlocks:/);
});

test("an unsupported chain is refused rather than silently defaulted", async () => {
  const errs = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    const rc = await follow.run({ argv: ["vitalik.eth", "--chain", "dogecoin"] });
    assert.equal(rc, 1);
  } finally {
    process.stderr.write = write;
  }
  assert.match(errs.join(""), /unsupported chain/i);
});

test("a non-numeric --blocks is refused before any network call", async () => {
  const errs = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { errs.push(String(s)); return true; };
  try {
    const rc = await follow.run({ argv: ["vitalik.eth", "--blocks", "abc"] });
    assert.equal(rc, 1);
  } finally {
    process.stderr.write = write;
  }
  assert.match(errs.join(""), /positive number/i);
});

test("bare invocation prints usage and exits non-zero", async () => {
  const out = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try {
    const rc = await follow.run({ argv: [] });
    assert.equal(rc, 1, "no argument is a usage error, not a success");
  } finally {
    process.stdout.write = write;
  }
  assert.match(out.join(""), /oracle follow </);
});

test("the command never claims an empty window proves an idle wallet", () => {
  // A scoped read is not proof of absence, and the copy must not imply it.
  assert.match(SRC, /no ERC20 transfers in this window/);
  assert.doesNotMatch(SRC, /no activity\b/i);
});

test("it stays read-only: no signing verbs reachable from the command", () => {
  for (const banned of ["privateKey", "signTransaction", "sendRawTransaction", "eth_sendTransaction"]) {
    assert.ok(!SRC.includes(banned), `follow must not reference ${banned}`);
  }
});
