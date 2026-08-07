// The agent-grants entry point is a product surface another team builds
// against, so its shape and its custody posture are both load-bearing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as grants from "../src/public-api/agent-grants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("the entry point exposes the full grant lifecycle", () => {
  // A partial surface forces deep imports into internals, which is exactly the
  // problem this module exists to solve.
  for (const fn of [
    "planConnection",      // build the unsigned grant to show the user
    "activateSession",     // accept the owner signature
    "revokeSession",       // first-class revocation
    "listActiveGrants",    // read what is live
    "getGrant",
    "classifyGrant",
    "describeActive",
  ]) {
    assert.equal(typeof grants[fn], "function", `${fn} must be reachable from the entry point`);
  }
  assert.ok(grants.GRANT_STATUS.ACTIVE);
  assert.ok(grants.policy, "policy schema must be reachable");
  assert.ok(grants.render, "policy render must be reachable");
});

test("reads are deterministic over an injected store and clock", () => {
  // Same inputs, same answer — no hidden clock, no database.
  const store = [
    { grant: { grantId: "g1", expiresAt: 2000, agentAddress: "0xa", accountAddress: "0xb", chainId: 1 } },
    { grant: { grantId: "g2", expiresAt: 500, agentAddress: "0xa", accountAddress: "0xb", chainId: 1 } },
  ];
  const a = grants.listActiveGrants(store, { now: 1000 });
  const b = grants.listActiveGrants(store, { now: 1000 });
  assert.deepEqual(a, b);
  const ids = a.map((g) => g.grantId ?? g.grant?.grantId);
  assert.ok(!ids.includes("g2"), "an expired grant must not read as active");
});

test("revocation is honoured on read", () => {
  const store = [{ grant: { grantId: "g1", expiresAt: 9999 }, revoked: true }];
  assert.deepEqual(grants.listActiveGrants(store, { now: 1 }), []);
});

test("a malformed store is rejected, not silently treated as empty", () => {
  // Returning [] for a broken store would read as "no permissions" and could
  // mask a bug that should fail loudly.
  assert.throws(() => grants.listActiveGrants(42, { now: 1 }), TypeError);
});

test("the posture object matches what the code actually does", () => {
  assert.equal(grants.GRANTS_POSTURE.houseCustody, false);
  assert.equal(grants.GRANTS_POSTURE.storesPrivateKeys, false);
  assert.equal(grants.GRANTS_POSTURE.userSigns, true);
  assert.equal(grants.GRANTS_POSTURE.revocable, true);
});

test("the entry point holds no key material", () => {
  const src = readFileSync(resolve(HERE, "..", "src/public-api/agent-grants.mjs"), "utf8");
  for (const banned of ["privateKey", "PRIVATE_KEY", "mnemonic", "signTransaction", "sendRawTransaction"]) {
    assert.ok(!src.includes(banned), `agent-grants must not reference ${banned}`);
  }
});

test("the package export resolves", async () => {
  const pkg = JSON.parse(readFileSync(resolve(HERE, "..", "package.json"), "utf8"));
  assert.equal(pkg.exports["./agent-grants"], "./src/public-api/agent-grants.mjs",
    "the subpath must be declared or consumers cannot import it");
});
