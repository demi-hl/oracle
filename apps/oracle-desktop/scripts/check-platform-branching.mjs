#!/usr/bin/env node
// Verify the mac/Windows launch paths from Linux.
//
// planLaunch is pure, so the other two platforms are testable here. This does
// not replace running on real runners — it catches the class of bug that shipped
// twice already: logic that only ever executed on Linux asserting things that
// are false everywhere else.

import assert from "node:assert/strict";
import { join } from "node:path";

import { planLaunch, explainFailure } from "./smoke-electron.mjs";

const POSIX_ONLY = (p) => !p.endsWith(".cmd");
const WINDOWS_ONLY = (p) => p.endsWith(".cmd");
const NO_XVFB = () => false;
const HAS_XVFB = () => true;

const checks = [
  [
    "macOS launches electron directly, never xvfb",
    () => {
      const plan = planLaunch({ platform: "darwin", display: "", waylandDisplay: "", exists: POSIX_ONLY, hasXvfb: NO_XVFB });
      assert.equal(plan.command.endsWith("electron"), true, "should launch the electron binary");
      assert.equal(plan.shell, false);
      assert.ok(!plan.args.includes("-a"), "should not route through xvfb-run");
    },
  ],
  [
    "Windows resolves the .cmd shim and needs shell:true",
    () => {
      const plan = planLaunch({ platform: "win32", display: "", waylandDisplay: "", exists: WINDOWS_ONLY, hasXvfb: NO_XVFB });
      assert.equal(plan.command.endsWith("electron.cmd"), true, "should find the .cmd shim");
      assert.equal(plan.shell, true, ".cmd is not directly executable by CreateProcess");
    },
  ],
  [
    "headless Linux routes through xvfb-run",
    () => {
      const plan = planLaunch({ platform: "linux", display: "", waylandDisplay: "", exists: POSIX_ONLY, hasXvfb: HAS_XVFB });
      assert.equal(plan.command, "xvfb-run");
      assert.deepEqual(plan.args.slice(0, 1), ["-a"]);
    },
  ],
  [
    "Linux with a display launches electron directly",
    () => {
      const plan = planLaunch({ platform: "linux", display: ":0", waylandDisplay: "", exists: POSIX_ONLY, hasXvfb: NO_XVFB });
      assert.equal(plan.command.endsWith("electron"), true);
    },
  ],
  [
    "headless Linux without xvfb fails with an actionable message",
    () => {
      assert.throws(
        () => planLaunch({ platform: "linux", display: "", waylandDisplay: "", exists: POSIX_ONLY, hasXvfb: NO_XVFB }),
        /install xvfb/,
      );
    },
  ],
  [
    "a genuinely missing binary is still reported",
    () => {
      assert.throws(
        () => planLaunch({ platform: "darwin", display: "", waylandDisplay: "", exists: () => false, hasXvfb: NO_XVFB }),
        /missing electron binary/,
      );
    },
  ],
  [
    "the sandbox failure names the fix instead of the symptom",
    () => {
      const message = explainFailure("FATAL:... chrome-sandbox is owned by", { status: null, signal: "SIGTRAP" });
      assert.match(message, /chmod 4755/, "should tell the reader how to fix the helper");
      assert.match(message, /rather than passing --no-sandbox/, "should steer away from the easy wrong fix");
    },
  ],
];

let failed = 0;
for (const [label, run] of checks) {
  try {
    run();
    console.log(`  OK   ${label}`);
  } catch (error) {
    console.log(`  FAIL ${label}: ${error.message.split("\n")[0]}`);
    failed += 1;
  }
}

console.log(`\n${checks.length} launch-plan checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
