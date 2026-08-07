// Local-first binding.
//
// Every upstream this app talks to is loopback-enforced: the signer bridge, the
// swap desk, and the public data plane all reject non-loopback hosts. The app's
// own listener was the exception. `next start` binds 0.0.0.0 by default, so the
// whole surface answered on the LAN IP while the product claimed a local
// topology.
//
// The default is now 127.0.0.1, overridable with ORACLE_APP_HOST for the
// deliberate case (containers, a reverse proxy the operator owns).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));

test("dev and start bind loopback by default", () => {
  for (const name of ["dev", "start"]) {
    const script = pkg.scripts[name];
    assert.ok(script, `${name} script is missing`);
    assert.match(
      script,
      /--hostname \$\{ORACLE_APP_HOST:-127\.0\.0\.1\}/,
      `${name} does not default to a loopback bind`,
    );
  }
});

test("the loopback default is overridable, not hardcoded", () => {
  // A hardcoded 127.0.0.1 would break container and reverse-proxy deployments
  // the operator explicitly opts into.
  for (const name of ["dev", "start"]) {
    assert.match(pkg.scripts[name], /ORACLE_APP_HOST/);
  }
});

test("upstream routes still refuse non-loopback hosts", () => {
  // The app binding loopback is not sufficient on its own: if these guards were
  // relaxed, a local page could still drive a remote signer or desk.
  for (const file of [
    "app/api/oracle/signer/route.ts",
    "app/api/oracle/swap/prepare/route.ts",
  ]) {
    const source = readFileSync(join(appRoot, file), "utf8");
    assert.match(
      source,
      /host !== "127\.0\.0\.1" && host !== "localhost" && host !== "::1"/,
      `${file} no longer restricts its upstream to loopback`,
    );
  }
});
