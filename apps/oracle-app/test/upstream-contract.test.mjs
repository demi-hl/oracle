// Upstream contract drift.
//
// The app talks to two different planes through @oracle-agent/contract: the
// public data plane (shipped in this repo as oracle-public-server) and a desk
// plane provided by the separately installed, private operator package.
//
// Nothing checked that the paths the app depends on are actually served, so
// drift was invisible until a request 404'd behind a UI that still looked like
// it was working. That is the same defect class as the claims audit: a surface
// asserting a capability the code does not have.
//
// This pins which plane owns each route and fails if a data-plane path the app
// depends on is not in the shipped server's route table.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const CONTRACT = readFileSync(join(repoRoot, "packages/contract/src/index.ts"), "utf8");
const SERVER = readFileSync(join(repoRoot, "packages/oracle/src/public-api/http.mjs"), "utf8");

/** Every upstreamPath the app depends on, by route id. */
function contractPaths() {
  const out = new Map();
  for (const m of CONTRACT.matchAll(/(\w+): \{ id: "([^"]+)"[^}]*upstreamPath: "([^"]+)"/g)) {
    out.set(m[2], m[3]);
  }
  assert.ok(out.size >= 8, `expected the contract to declare routes, found ${out.size}`);
  return out;
}

/** The shipped public server's actual route table. */
function servedPaths() {
  const start = SERVER.indexOf("const ROUTES");
  assert.ok(start !== -1, "could not locate ROUTES in the public server");
  const block = SERVER.slice(start, SERVER.indexOf("});", start));
  const paths = [...block.matchAll(/"(?:GET|POST) ([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length > 0, "public server exposes no routes");
  return new Set(paths);
}

/**
 * Routes owned by the private operator package, not by this repo. These are
 * expected to be absent from the shipped server; the app must degrade honestly
 * when they are unreachable rather than present a working surface.
 */
const DESK_PLANE = new Set([
  "swap.prepare",
  "revoke.prepare",
  "signer.status",
  "health",
  "catalog",
  "providerHealth",
]);

test("every data-plane path the app depends on is served by the shipped server", () => {
  const contract = contractPaths();
  const served = servedPaths();
  const missing = [];
  for (const [id, path] of contract) {
    if (DESK_PLANE.has(id)) continue;
    if (!served.has(path)) missing.push(`${id} -> ${path}`);
  }
  assert.deepEqual(
    missing,
    [],
    `the app depends on data-plane routes the public server does not serve:\n  ${missing.join("\n  ")}`,
  );
});

test("desk-plane routes are absent from the public server", () => {
  // If one of these ever appears here, the public keyless surface has grown a
  // prepare or signer path and the custody boundary needs re-argued.
  const contract = contractPaths();
  const served = servedPaths();
  for (const id of DESK_PLANE) {
    const path = contract.get(id);
    if (!path) continue;
    assert.ok(
      !served.has(path),
      `${id} (${path}) is now served by the public plane; custody boundary changed`,
    );
  }
});

test("the public server serves no route that can sign or broadcast", () => {
  for (const path of servedPaths()) {
    assert.ok(
      !/\b(sign|broadcast|send|execute|arm)\b/i.test(path),
      `public server exposes ${path}, which reads as a signing or execution route`,
    );
  }
});
