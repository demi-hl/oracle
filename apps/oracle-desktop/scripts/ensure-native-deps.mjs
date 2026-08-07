#!/usr/bin/env node
// Install the native binaries this platform needs but the lockfile does not pin.
//
// package-lock.json was generated on linux-x64, so it records only
// lightningcss-linux-x64-gnu and @tailwindcss/oxide-linux-x64-gnu. `npm ci` is
// lockfile-exact by design, so on macOS and Windows it produces a tree that
// installs cleanly and then fails the Next build with:
//
//   Cannot find module '../lightningcss.<platform>.node'
//
// Regenerating the lockfile with every platform's optionals is the cleaner fix,
// but npm 12 refuses to resolve the wasm fallback variants ("Fetching packages
// of type remote have been disabled"), so it cannot produce a complete
// cross-platform lockfile here. Installing the current platform's binaries
// explicitly is deterministic, version-pinned to the lockfile's own versions,
// and a no-op on linux.

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function version(pkg) {
  return require(join(root, "node_modules", pkg, "package.json")).version;
}

const arch = process.arch === "arm64" ? "arm64" : "x64";
const targets = {
  darwin: [`lightningcss-darwin-${arch}`, `@tailwindcss/oxide-darwin-${arch}`],
  win32: [`lightningcss-win32-${arch}-msvc`, `@tailwindcss/oxide-win32-${arch}-msvc`],
  linux: [],
}[process.platform] || [];

if (targets.length === 0) {
  console.log(`  OK   no extra native packages needed on ${process.platform}`);
  process.exit(0);
}

const missing = targets.filter((pkg) => !existsSync(join(root, "node_modules", ...pkg.split("/"))));
if (missing.length === 0) {
  console.log(`  OK   native packages already present on ${process.platform}/${arch}`);
  process.exit(0);
}

const specs = missing.map((pkg) => {
  const base = pkg.startsWith("@tailwindcss/") ? "@tailwindcss/oxide" : "lightningcss";
  return `${pkg}@${version(base)}`;
});

console.log(`  ..   installing ${specs.join(" ")}`);
const run = spawnSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", ...specs], {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (run.status !== 0) {
  console.error(`  FAIL could not install native packages for ${process.platform}/${arch}`);
  process.exit(1);
}

const stillMissing = missing.filter((pkg) => !existsSync(join(root, "node_modules", ...pkg.split("/"))));
if (stillMissing.length) {
  console.error(`  FAIL native packages still missing after install: ${stillMissing.join(", ")}`);
  process.exit(1);
}

console.log(`  OK   native packages ready for ${process.platform}/${arch}`);
