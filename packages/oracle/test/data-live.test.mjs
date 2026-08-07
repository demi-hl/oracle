// Optional live public API probes. Skipped unless ORACLE_LIVE_DATA=1.
//
// These hit real public endpoints, so they are opt-in: a contributor running the
// suite offline (or behind a flaky link) should get a clean pass, not a red suite
// caused by someone else's rate limit. CI runs them nowhere by default.
//
// Never touches wallet keys or any execute flag.

import { test } from "node:test";
import assert from "node:assert/strict";
import { data } from "../src/data/desk-data.mjs";

// ORACLE_LIVE_DATA is the documented name; MAD_LIVE_DATA stays as a legacy alias
// so an existing checkout does not silently stop running these.
const live =
  process.env.ORACLE_LIVE_DATA === "1" || process.env.MAD_LIVE_DATA === "1";

test("LIVE: HL allMids returns prices", { skip: !live }, async () => {
  const mids = await data.hl.allMids({ timeoutMs: 15_000 });
  assert.equal(typeof mids, "object");
  assert.ok(Object.keys(mids).length > 10);
});

test("LIVE: Poly CLOB time ok", { skip: !live }, async () => {
  const h = await data.poly.health({ timeoutMs: 15_000 });
  assert.equal(h.ok, true);
});

test("LIVE: dataHealth public providers (rh may fail off private host)", { skip: !live }, async () => {
  const report = await data.health({
    providers: ["hl-info", "poly-public"],
    timeoutMs: 15_000,
  });
  assert.equal(report.exec, false);
  assert.equal(report.providers["hl-info"].ok, true);
  assert.equal(report.providers["poly-public"].ok, true);
});
