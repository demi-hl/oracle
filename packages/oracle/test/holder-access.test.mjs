import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PACKAGE, "../..");
const read = (path) => readFileSync(path, "utf8");

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("ordinary CLI commands do not require a holder wallet", () => {
  const home = join(tmpdir(), `oracle-public-access-${process.pid}-${Date.now()}`);
  const run = spawnSync(process.execPath, [join(PACKAGE, "bin/oracle.mjs"), "chain", "list"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ORACLE_TEST_ISOLATE_SECRETS: "1",
    },
  });

  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /holder|Locals Only|gate status/i);
});

test("the CLI and release automation contain no access-gate bypass", () => {
  const surfaces = [
    join(PACKAGE, "src/cli/kernel.mjs"),
    join(PACKAGE, "package.json"),
    join(PACKAGE, "scripts/smoke-dist-bins.mjs"),
    join(ROOT, ".github/workflows/ci.yml"),
    join(ROOT, ".github/workflows/desktop.yml"),
  ];

  for (const file of surfaces) {
    const body = read(file);
    assert.doesNotMatch(body, /ORACLE_GATE_BYPASS|holder-access\.mjs|checkAccess\(/, file);
  }

  const commandNames = readdirSync(join(PACKAGE, "src/cli/commands"));
  assert.equal(commandNames.includes("gate.mjs"), false);
});

test("Locals Only references in runtime source are fee-waiver only", () => {
  const allowed = new Set([
    "src/cli/commands/fees.mjs",
    "src/cli/kernel.mjs",
    "src/data/providers/lifi.mjs",
    "src/data/providers/paraswap.mjs",
    "src/licensing/locals-only.mjs",
    "src/router/integrator-fee.mjs",
  ]);
  const unexpected = filesUnder(join(PACKAGE, "src"))
    .filter((file) => /\.m?js$/.test(file))
    .filter((file) => /Locals Only|LOCALS_ONLY/.test(read(file)))
    .map((file) => file.slice(PACKAGE.length + 1))
    .filter((file) => !allowed.has(file));

  assert.deepEqual(unexpected, []);
});

test("Locals Only status cannot alter API access or rate limits", () => {
  for (const file of ["src/public-api/metering.mjs", "src/public-api/buzz-integration.mjs"]) {
    assert.doesNotMatch(read(join(PACKAGE, file)), /Locals Only|isHolder|TIERS\.holder|tier === "holder"/i, file);
  }
});

test("retired distribution-gate entrypoints are absent", () => {
  const retired = [
    "bin/oracle-gate-server.mjs",
    "src/cli/holder-access.mjs",
    "src/cli/commands/gate.mjs",
    "src/gate/holder-gate.mjs",
  ];
  const present = retired.filter((file) => {
    try {
      read(join(PACKAGE, file));
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(present, []);
});
