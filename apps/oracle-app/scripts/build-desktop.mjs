#!/usr/bin/env node
// Run `next build` with ORACLE_DESKTOP_BUILD=1 set.
//
// The script used to be `ORACLE_DESKTOP_BUILD=1 next build`, which is POSIX
// shell syntax. npm runs scripts through cmd.exe on Windows, where that is not
// an assignment — it is a command name, and the build died with
// "'ORACLE_DESKTOP_BUILD' is not recognized as an internal or external command".
//
// Setting it here keeps the behaviour identical on all three platforms without
// adding a cross-env dependency for one variable.

import { spawnSync } from "node:child_process";

const run = spawnSync("next", ["build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, ORACLE_DESKTOP_BUILD: "1" },
});

process.exit(run.status ?? 1);
