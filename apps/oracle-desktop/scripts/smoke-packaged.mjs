#!/usr/bin/env node
// Package the app, then RUN THE PACKAGED BINARY and demand a smoke receipt.
//
// This is the gate that matters. Everything upstream — unit tests, the staged
// HTTP smoke, even the Electron smoke — runs against the source tree, and all
// of them were green while the packaged artifact died on launch with
// "Cannot find module 'next'": electron-builder's extraResources copy stripped
// node_modules out of the staged runtime, so the app built clean and was broken
// only for the person who installed it.
//
// Build-succeeded is not evidence. Run the thing you are about to hand someone.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { explainFailure } from "./smoke-electron.mjs";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(desktopDir, "release");

function fail(message) {
  console.error(`  FAIL ${message}`);
  process.exit(1);
}

// electron-builder names the output dir per platform AND arch: mac, mac-arm64,
// linux-unpacked, win-unpacked. Hardcoding one of them made the gate crash with
// ENOENT on Apple Silicon after a perfectly good build.
function outputDir(prefixes) {
  if (!existsSync(releaseDir)) fail(`no release dir at ${releaseDir}`);
  const match = readdirSync(releaseDir).find((entry) => prefixes.some((p) => entry === p || entry.startsWith(`${p}-`)));
  if (!match) fail(`no output dir matching ${prefixes.join("/")} in ${releaseDir} (found: ${readdirSync(releaseDir).join(", ")})`);
  return join(releaseDir, match);
}

// The packaged executable name differs per platform; find it rather than
// hardcoding a name that will silently drift from the builder config.
function packagedBinary() {
  if (process.platform === "darwin") {
    const dir = outputDir(["mac"]);
    const app = readdirSync(dir).find((entry) => entry.endsWith(".app"));
    if (!app) fail(`no .app bundle in ${dir}`);
    return join(dir, app, "Contents", "MacOS", app.replace(/\.app$/, ""));
  }
  if (process.platform === "win32") {
    const dir = outputDir(["win-unpacked"]);
    const exe = readdirSync(dir).find((entry) => entry.endsWith(".exe"));
    if (!exe) fail(`no .exe in ${dir}`);
    return join(dir, exe);
  }
  return join(outputDir(["linux-unpacked"]), "oracle-desktop");
}

const binary = packagedBinary();
if (!existsSync(binary)) fail(`packaged binary missing at ${binary}`);

// Prove the runtime the app needs actually shipped, before launching. A clear
// "node_modules missing" beats parsing a MODULE_NOT_FOUND stack.
const resources =
  process.platform === "darwin"
    ? join(dirname(dirname(binary)), "Resources")
    : join(dirname(binary), "resources");
const runtime = join(resources, "oracle-app");
if (!existsSync(join(runtime, "apps", "oracle-app", "server.js"))) fail(`packaged runtime has no server.js (${runtime})`);
if (!existsSync(join(runtime, "node_modules", "next"))) fail(`packaged runtime cannot resolve next (${runtime})`);

// The packaged app IS the executable; there is no npm shim to resolve. Only the
// headless-Linux case needs a wrapper.
const headlessLinux = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
if (headlessLinux && spawnSync("sh", ["-c", "command -v xvfb-run"]).status !== 0) {
  fail("no display and xvfb-run is unavailable; install xvfb to run the packaged smoke");
}

// The packaged bytes are the product. Prove no developer-machine path, internal
// compute host, or private-lane env name shipped inside them — a source-tree
// grep proves nothing about what electron-builder actually copied.
const FORBIDDEN = [
  { name: "developer home path", pattern: /\/home\/demi/ },
  { name: "internal compute host", pattern: /arch-demi/ },
  { name: "internal compute env", pattern: /ORACLE_ARCH_COMPUTE_HOST/ },
  { name: "armed exec default", pattern: /MAD_EXECUTE_ENABLED=1/ },
  { name: "packed publish tarball", pattern: /\.publish-stage/ },
];

function scanPackagedBytes() {
  const asar = join(resources, "app.asar");
  if (!existsSync(asar)) fail(`packaged app.asar missing at ${asar}`);
  const targets = [asar];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).size <= 8_000_000) targets.push(full);
    }
  };
  walk(runtime);

  const hits = [];
  for (const file of targets) {
    let text;
    try {
      text = readFileSync(file, "latin1");
    } catch {
      continue;
    }
    for (const rule of FORBIDDEN) {
      // The Next server bakes its build cwd into required-server-files.json and
      // server.js; that is a build artifact path, not a shipped capability, and
      // it exists in every Next standalone output.
      if (rule.name === "developer home path" && /required-server-files\.json$|server\.js$/.test(file)) continue;
      if (rule.pattern.test(text)) hits.push(`${file.replace(resources, "<resources>")}: ${rule.name}`);
    }
  }
  if (hits.length) {
    for (const hit of hits.slice(0, 20)) console.error(`  leak ${hit}`);
    fail(`packaged bytes leak ${hits.length} private-surface marker(s)`);
  }
  console.log(`  OK   packaged bytes scanned (${targets.length} files), no private-surface markers`);
}

scanPackagedBytes();

// Run the packaged CLI exactly as the desktop terminal runs it, and demand the
// public lane works AND the private lanes refuse.
function packagedCliMatrix() {
  // The CLI ships inside app.asar (the app's own node_modules), which is exactly
  // where main.cjs resolves it from. Electron reads asar paths natively, and the
  // desktop spawns the Electron binary with ELECTRON_RUN_AS_NODE, so this is the
  // real path the terminal executes — not an approximation of it.
  const cli = join(resources, "app.asar", "node_modules", "@oracle-agent", "oracle", "bin", "oracle.mjs");
  const home = mkdtempSync(join(tmpdir(), "oracle-desktop-cli-"));
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    ORACLE_PUBLIC_DESKTOP: "1",
    ORACLE_REMOTE_COMPUTE_DISABLE: "1",
    // Deliberately point at a host operator to prove the desktop wall ignores it.
    ORACLE_OPERATOR_BIN_DIR: "/usr/local/bin",
    ORACLE_EXECUTE_ENABLED: "0",
    MAD_EXECUTE_ENABLED: "0",
    ORACLE_FAKE_HOME: home,
    HOME: home,
  };
  const cases = [
    ["help", ["--help"], 0, /self-custody multichain agent control plane/],
    ["version", ["version"], 0, /^oracle \d+\.\d+\.\d+\s*$/m],
    ["sign refused", ["vault", "inspect", "x"], 3, /signing is unavailable in the public package/],
    ["signer refused", ["signer"], 3, /signing is unavailable in the public package/],
    ["remote compute refused", ["model", "--backend", "arch", "--compute-host", "arch-demi"], 1, /remote compute backends are disabled/],
  ];
  // `mad-desk` is a legacy compat dir that legitimately exists in the published
  // package. Presence in bytes is fine; REACHABILITY from the desktop is not.
  const isolation = spawnSync(binary, [
    "-e",
    `process.env.ORACLE_PUBLIC_DESKTOP="1";process.env.ORACLE_CONFIG_DIR=${JSON.stringify(join(home, ".config", "oracle"))};` +
      `import(${JSON.stringify("file://" + join(resources, "app.asar", "node_modules", "@oracle-agent", "oracle", "src", "oracle-env.mjs"))})` +
      `.then((m)=>{console.log(JSON.stringify({cfg:m.ORACLE_CONFIG_DIR,legacy:m.LEGACY_CONFIG_DIR}));});`,
  ], { encoding: "utf8", env, timeout: 60_000 });
  const isoLine = (isolation.stdout || "").split("\n").find((l) => l.trim().startsWith("{"));
  if (!isoLine) fail(`config isolation probe produced no result: ${(isolation.stdout || "") + (isolation.stderr || "")}`);
  const iso = JSON.parse(isoLine);
  if (/mad-desk/.test(iso.legacy) || /mad-desk/.test(iso.cfg)) {
    fail(`packaged desktop can still resolve a private desk config dir: ${isoLine}`);
  }
  try {
    for (const [label, args, expected, matcher] of cases) {
      const r = spawnSync(binary, [cli, ...args], { encoding: "utf8", env, timeout: 60_000 });
      const text = `${r.stdout || ""}${r.stderr || ""}`;
      if (r.status !== expected) fail(`packaged CLI "${label}" exited ${r.status}, expected ${expected}: ${text.slice(0, 300)}`);
      if (!matcher.test(text)) fail(`packaged CLI "${label}" output did not match ${matcher}: ${text.slice(0, 300)}`);
    }
    // `oracle version` must not advertise a host operator inside the desktop.
    const version = spawnSync(binary, [cli, "version"], { encoding: "utf8", env, timeout: 60_000 });
    if (/operator\s+\d/i.test(`${version.stdout || ""}`)) {
      fail(`packaged CLI resolved a host operator: ${version.stdout.trim()}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  console.log(`  OK   packaged CLI matrix: public lane runs, sign/remote-compute lanes refuse`);
}

packagedCliMatrix();

const run = spawnSync(
  headlessLinux ? "xvfb-run" : binary,
  headlessLinux ? ["-a", binary] : [],
  {
    cwd: desktopDir,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, ORACLE_DESKTOP_SMOKE: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  },
);

const output = `${run.stdout || ""}${run.stderr || ""}`;
const receiptLine = output
  .split("\n")
  .reverse()
  .find((line) => line.trim().startsWith("{") && line.includes("\"health\""));

if (!receiptLine) {
  const noise = /Fontconfig|GroupMarkerNotSet|viz_main_impl|GPU process|Exiting GPU|dbus/;
  console.error(output.split("\n").filter((l) => l.trim() && !noise.test(l)).join("\n"));
  fail(explainFailure(output, run));
}

const receipt = JSON.parse(receiptLine);
if (receipt.ok !== true) fail(`packaged app smoke failed: ${receiptLine}`);
if (receipt.health !== "public-keyless-prepare-only") fail(`packaged app custody posture: ${receipt.health}`);
if (!(receipt.bodyLength > 200)) fail(`packaged app painted a near-empty document (${receipt.bodyLength} chars)`);

console.log(
  `  OK   packaged app booted on ${process.platform}: ${receipt.title} (${receipt.bodyLength} chars), custody ${receipt.health}`,
);
