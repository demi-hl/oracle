// The CLI health checks probed a route the server intentionally 404s, and
// doctor looked for a secret name `oracle init --apply` never writes.
//
// Effect before the fix, against the package's own running 0.10.0 server:
//   GET /        -> 404 {"error":"not found","routes":[...]}
//   GET /health  -> 200 {"ok":true,...}
//   oracle data health -> exit 1
//   oracle doctor      -> data_server "down http://..." while it was up
//
// Found by the gpt-56 lane of the 2026-08-03 four-model review.
//
// Asserted against the server's real route table rather than a hardcoded
// string, so moving the endpoint breaks this test instead of silently
// reintroducing the mismatch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const dataCmd = readFileSync(resolve(ROOT, "src/cli/commands/data.mjs"), "utf8");
const doctorCmd = readFileSync(resolve(ROOT, "src/cli/commands/doctor.mjs"), "utf8");
const deskServer = readFileSync(resolve(ROOT, "bin/desk-server.mjs"), "utf8");
const initBin = readFileSync(resolve(ROOT, "bin/oracle-init.mjs"), "utf8");

test("the server actually serves the health route the CLI probes", () => {
  assert.ok(deskServer.includes("/health"), "desk-server must expose /health");

  const healthProbe = dataCmd.match(/verb === "health"\)\s*return dataFetch\("([^"]+)"\)/);
  assert.ok(healthProbe, "oracle data health must issue a health fetch");
  assert.equal(
    healthProbe[1],
    "/health",
    "oracle data health must probe /health — / intentionally 404s with a route list"
  );
});

test("doctor probes the health route, not the 404 root", () => {
  const probe = doctorCmd.match(/probeDataServer[\s\S]*?fetch\(url\.replace\(\/\\\/\$\/, ""\) \+ "([^"]+)"\)/);
  assert.ok(probe, "doctor must probe the data server over http");
  assert.equal(
    probe[1],
    "/health",
    "doctor must probe /health, otherwise it reports a healthy server as down"
  );
});

test("doctor checks the attestation secret name that init actually writes", () => {
  const written = [...initBin.matchAll(/(\w*ROUTE_ATTESTATION_SECRET)=/g)].map((m) => m[1]);
  assert.ok(written.length, "oracle init must write a route attestation secret");

  for (const name of new Set(written)) {
    assert.ok(
      doctorCmd.includes(name),
      `doctor must recognize ${name} — init writes it, so checking only other names ` +
        `tells the user to rerun an init step that cannot satisfy the check`
    );
  }
});
