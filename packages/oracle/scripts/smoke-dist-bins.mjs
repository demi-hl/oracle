#!/usr/bin/env node
// Spawn every published bin from the STAGED layout and fail on a startup crash.
//
// This gate exists because 0.12.0 shipped two bins that died at module load:
// `oracle-data` read dist/package.json and `oracle init` read dist/profiles/,
// neither of which exists once the package is staged. Nothing caught it because
// verify-dist only compares export names, and every local run resolved the
// source tree where ../package.json happens to be real. Only the staged layout
// reproduces what a user installs, so the smoke has to run there.
//
//   node scripts/smoke-dist-bins.mjs <stage-dir>

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const stage = resolve(process.argv[2] || ".publish-stage");
const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));

// Servers block forever on purpose; a bounded run that reaches "listening"
// without crashing is the pass condition for those.
const SERVER_BINS = new Set(["oracle-data", "oracle-public"]);
const ARGS = { "oracle-upgrade": ["--json"] };
const FATAL = /ENOENT|Cannot find module|ERR_MODULE_NOT_FOUND|is not a function|is not defined/;

let failed = 0;
for (const [name, target] of Object.entries(manifest.bin || {})) {
  const entry = join(stage, target);
  if (!existsSync(entry)) {
    console.log(`  FAIL ${name.padEnd(18)} missing entry ${target}`);
    failed += 1;
    continue;
  }
  const args = ARGS[name] || ["--help"];
  const run = spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    timeout: SERVER_BINS.has(name) ? 6000 : 30000,
    env: {
      ...process.env,
      // A server that binds a live port would collide with a real one.
      ORACLE_DATA_PORT: "8791",
      ORACLE_PUBLIC_PORT: "8792",
    },
  });
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const crashed = FATAL.test(output);
  const died = !SERVER_BINS.has(name) && run.status === null && !run.error?.code?.includes("TIMEDOUT");
  if (crashed || died) {
    const first = output.split("\n").filter(Boolean).slice(0, 4).join(" | ").slice(0, 200);
    console.log(`  FAIL ${name.padEnd(18)} ${first}`);
    failed += 1;
    continue;
  }
  console.log(`  OK   ${name.padEnd(18)} started clean`);
}

// Spawning each bin directly is NOT enough. The `oracle` dispatcher resolves
// sibling bins through its own path helper, and that helper computed
// `<root>/bin/` — correct in the source tree, absent in the bundle. So
// `oracle-init` started clean while `oracle init` died with MODULE_NOT_FOUND
// for every installer. Exercise the routed form too.
const DISPATCHED = [
  ["init", ["init"], /Cannot find module|MODULE_NOT_FOUND/],
  ["scan", ["scan", "chains"], /Cannot find module|MODULE_NOT_FOUND/],
  ["route", ["route"], /Cannot find module|MODULE_NOT_FOUND/],
  ["upgrade", ["upgrade", "--json"], /Cannot find module|MODULE_NOT_FOUND/],
  ["fees", ["fees", "status"], /Cannot find module|MODULE_NOT_FOUND/],
];
const dispatcher = join(stage, (manifest.bin || {}).oracle || "");
for (const [label, argv, fatal] of DISPATCHED) {
  const run = spawnSync(process.execPath, [dispatcher, ...argv], {
    encoding: "utf8",
    timeout: 45_000,
    env: {
      ...process.env,
      ORACLE_FAKE_HOME: join(stage, ".smoke-home"),
    },
  });
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  if (fatal.test(output)) {
    console.log(`  FAIL oracle ${label.padEnd(11)} ${output.split("\n").filter(Boolean).slice(0, 3).join(" | ").slice(0, 200)}`);
    failed += 1;
    continue;
  }
  console.log(`  OK   oracle ${label.padEnd(11)} dispatched clean`);
}

console.log(`\n${Object.keys(manifest.bin || {}).length} bins + ${DISPATCHED.length} dispatched commands, ${failed} broken`);
process.exitCode = failed ? 1 : 0;
