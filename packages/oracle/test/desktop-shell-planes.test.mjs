// The desktop shell must start BOTH planes and tell the app where they are.
//
// It previously started only the desk and set neither ORACLE_PUBLIC_URL nor
// ORACLE_DESK_URL. The app then defaulted to 127.0.0.1:8799, which nothing ever
// bound, so on a fresh install every wallet read silently degraded to "add a
// public wallet address" and swap prepare reported an unconfigured desk. The
// app looked broken out of the box while every component was present and fine.
//
// Static assertions on purpose: booting Electron under a unit runner is slow
// and flaky, and what regressed here was wiring, not behaviour.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAIN = join(root, "apps", "oracle-desktop", "src", "main.cjs");

test("desktop shell source is present", () => {
  assert.equal(existsSync(MAIN), true, `missing ${MAIN}`);
});

test("the shell starts the public read plane, not just the desk", () => {
  const src = readFileSync(MAIN, "utf8");
  assert.match(src, /async function startPublicPlane\(/);
  assert.match(src, /resolveOracleBin\("oracle-public"\)/);
  // Both must actually be invoked at boot, not merely defined.
  assert.match(src, /await startDataPlane\(\);/);
  assert.match(src, /await startPublicPlane\(\);/);
});

test("the shell tells the app where both planes live", () => {
  const src = readFileSync(MAIN, "utf8");
  // Without ORACLE_DESK_URL the swap surface can never build a quote.
  assert.match(src, /ORACLE_DESK_URL\s*=\s*process\.env\.ORACLE_DESK_URL\s*\|\|/);
  assert.match(src, /ORACLE_PUBLIC_URL\s*=\s*process\.env\.ORACLE_PUBLIC_URL\s*\|\|/);
});

test("both planes are bound to loopback and given reserved ports", () => {
  const src = readFileSync(MAIN, "utf8");
  assert.match(src, /ORACLE_PUBLIC_HOST\s*=\s*process\.env\.ORACLE_PUBLIC_HOST\s*\|\|\s*"127\.0\.0\.1"/);
  // A hardcoded port collides with anything already running; the shell reserves.
  assert.match(src, /ORACLE_PUBLIC_PORT\s*\|\|\s*\(await reservePort\(\)\)/);
});

test("the public plane is health-gated before the app boots", () => {
  const src = readFileSync(MAIN, "utf8");
  // The public server serves GET /public/health — NOT /health, which 404s.
  assert.match(src, /\/public\/health/);
  const publicIdx = src.indexOf("await startPublicPlane();");
  const appIdx = src.indexOf("await startBundledApp();");
  assert.ok(publicIdx > 0 && appIdx > publicIdx, "app must boot after the read plane is up");
});
