// Approvals empty-state copy — safety-language guard.
//
// The empty approval list is the highest-risk string in the product: it is
// read as "your wallet is safe" when it only means "nothing was found in this
// scope". This pins the wording so a future edit cannot quietly turn scan
// coverage into a clean bill of health.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAW = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../components/oracle/ApprovalsPane.tsx",
  ),
  "utf8",
);

// Strip comments. Prose explaining WHY a phrase is banned would otherwise trip
// the ban itself; only user-visible strings are under test here.
const PANE = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the empty state states scope rather than implying safety", () => {
  assert.ok(
    PANE.includes("Other chains, tokens, and spenders were not checked."),
    "the empty state must name what was NOT scanned",
  );
  assert.ok(
    PANE.includes("This is scan coverage, not a clean bill of health"),
    "the empty state must explicitly refuse a safety reading",
  );
});

test("no approval surface tells the user they are safe or clean", () => {
  // Phrases that assert a security verdict this scan cannot support.
  for (const claim of [
    "You're safe",
    "You are safe",
    "wallet is safe",
    "No risks",
    "no risky approvals",
    "All clear",
    "You're protected",
    "nothing to worry",
  ]) {
    assert.ok(
      !new RegExp(claim, "i").test(PANE),
      `approvals UI must not claim "${claim}" — the scan is scoped, not exhaustive`,
    );
  }
});

test("collapsed chains are not labelled clear", () => {
  // "clear" reads as audited-and-safe. Unscanned is not clear.
  assert.ok(
    !/chains clear/i.test(PANE),
    'collapsed chains must not be described as "clear"',
  );
  assert.ok(
    PANE.includes("chains with nothing found or not connected"),
    "collapsed chains must describe absence of findings, not safety",
  );
});

test("revoke preparation is never presented as a completed revoke", () => {
  assert.ok(
    /unsigned/i.test(PANE),
    "prepared calldata must be labelled unsigned",
  );
  assert.ok(
    PANE.includes("This allowance stays active until your wallet submits the transaction"),
    "the pane must state the allowance is still live after preparing",
  );
  for (const claim of ["Revoked successfully", "Approval revoked", "Revoke complete"]) {
    assert.ok(
      !new RegExp(claim, "i").test(PANE),
      `preparing a revoke must not be reported as "${claim}"`,
    );
  }
});
