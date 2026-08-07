#!/usr/bin/env node
// Boot the REAL Electron shell headlessly and prove the renderer painted.
//
// The HTTP smoke proves two servers answer. It says nothing about the desktop
// app: main.cjs could fail to resolve the staged server, the bundled CLI bin,
// or the window could load a blank document and every HTTP assertion would
// still pass. This runs the actual binary with ORACLE_DESKTOP_SMOKE=1, which
// makes main.cjs load the window, read document.title / body text / the app's
// own /api/health from inside the renderer, print a receipt, and exit.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const root = resolve(desktopDir, "../..");

/**
 * Decide how to launch Electron on this platform.
 *
 * Pure and exported so the mac/Windows paths are testable from Linux. Two bugs
 * lived here because the logic only ever ran on one OS:
 *
 *   1. `!DISPLAY && !WAYLAND_DISPLAY` called every mac and Windows box headless
 *      and demanded xvfb, which exists on neither.
 *   2. Only the POSIX `electron` shim was probed, so Windows (`electron.cmd`)
 *      reported a missing binary against a healthy install.
 */
export function planLaunch({
  platform = process.platform,
  display = process.env.DISPLAY,
  waylandDisplay = process.env.WAYLAND_DISPLAY,
  binDir = join(root, "node_modules", ".bin"),
  exists = existsSync,
  hasXvfb = () => spawnSync("sh", ["-c", "command -v xvfb-run"], { encoding: "utf8" }).status === 0,
} = {}) {
  const electron = [join(binDir, "electron"), join(binDir, "electron.cmd")].find((c) => exists(c));
  if (!electron) throw new Error(`missing electron binary under ${binDir}; run npm ci`);

  // Only X11/Wayland needs a virtual display.
  const needsVirtualDisplay = platform === "linux" && !display && !waylandDisplay;
  if (needsVirtualDisplay) {
    if (!hasXvfb()) {
      throw new Error("no display and xvfb-run is unavailable; install xvfb to run the desktop smoke");
    }
    return { command: "xvfb-run", args: ["-a", electron, "."], shell: false, electron };
  }

  return {
    command: electron,
    args: ["."],
    // .cmd shims are not directly executable by CreateProcess.
    shell: platform === "win32",
    electron,
  };
}

/** Turn a failed launch into the one line that actually explains it. */
export function explainFailure(output, { status, signal } = {}) {
  if (/chrome-sandbox/.test(output)) {
    return (
      "electron's SUID sandbox helper is misconfigured. Fix it rather than passing --no-sandbox:\n" +
      "  sudo chown root:root node_modules/electron/dist/chrome-sandbox\n" +
      "  sudo chmod 4755 node_modules/electron/dist/chrome-sandbox"
    );
  }
  if (/cannot open display|Missing X server/i.test(output)) {
    return "no usable display: install xvfb or export DISPLAY";
  }
  return `desktop shell did not emit a smoke receipt (exit ${status}, signal ${signal})`;
}

function main() {
  const plan = planLaunch();
  const run = spawnSync(plan.command, plan.args, {
    cwd: desktopDir,
    encoding: "utf8",
    timeout: 180_000,
    shell: plan.shell,
    env: { ...process.env, ORACLE_DESKTOP_SMOKE: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });

  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const receiptLine = output
    .split("\n")
    .reverse()
    .find((line) => line.trim().startsWith("{") && line.includes("\"health\""));

  if (!receiptLine) {
    const noise = /Fontconfig|GroupMarkerNotSet|viz_main_impl|GPU process|Exiting GPU/;
    console.error(output.split("\n").filter((l) => l.trim() && !noise.test(l)).join("\n"));
    throw new Error(explainFailure(output, run));
  }

  const receipt = JSON.parse(receiptLine);
  if (receipt.ok !== true) throw new Error(`desktop smoke failed: ${receiptLine}`);
  if (receipt.health !== "public-keyless-prepare-only") {
    throw new Error(`renderer read the wrong custody posture: ${receipt.health}`);
  }
  if (!receipt.title || !/oracle/i.test(receipt.title)) {
    throw new Error(`renderer painted an unexpected document title: ${receipt.title}`);
  }
  if (!(receipt.bodyLength > 200)) {
    throw new Error(`renderer painted a near-empty document (${receipt.bodyLength} chars)`);
  }

  console.log(
    `  OK   electron shell rendered ${receipt.title} (${receipt.bodyLength} chars) on ${process.platform}, custody ${receipt.health}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
