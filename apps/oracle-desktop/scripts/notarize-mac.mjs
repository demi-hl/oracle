#!/usr/bin/env node
// Notarize and staple the built DMG.
//
// Signing alone is not enough for a downloaded app: since macOS 10.15 Gatekeeper
// also demands a notarization ticket from Apple. Without it the DMG opens with
// "Apple could not verify ... free of malware" and most users stop there.
//
// Stapling attaches the ticket to the DMG so it validates offline too.
//
// Runs separately from the build because notarization uploads the whole app to
// Apple and takes minutes. Belongs in a release, not in every CI run.

import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(desktopDir, "release");

const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER_ID = process.env.ASC_ISSUER_ID;
const KEY_PATH = process.env.ASC_KEY_PATH;

if (process.platform !== "darwin") {
  console.log("  OK   notarization only runs on macOS, skipping");
  process.exit(0);
}

if (!KEY_ID || !ISSUER_ID || !KEY_PATH || !existsSync(KEY_PATH)) {
  console.error("  FAIL need ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (App Store Connect API key)");
  process.exit(1);
}

if (!existsSync(releaseDir)) {
  console.error(`  FAIL no release dir at ${releaseDir}; build the DMG first`);
  process.exit(1);
}

const dmg = readdirSync(releaseDir).find((f) => f.endsWith(".dmg"));
if (!dmg) {
  console.error(`  FAIL no .dmg in ${releaseDir}`);
  process.exit(1);
}
const dmgPath = join(releaseDir, dmg);

// Verify the signature BEFORE uploading. Apple rejects unsigned or
// wrongly-signed bundles, and a local check fails in seconds instead of after a
// multi-minute upload.
const appDir = readdirSync(releaseDir).find((f) => f.startsWith("mac"));
if (appDir) {
  const app = readdirSync(join(releaseDir, appDir)).find((f) => f.endsWith(".app"));
  if (app) {
    const appPath = join(releaseDir, appDir, app);
    try {
      execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "pipe" });
      const info = execSync(`codesign -dv --verbose=4 "${appPath}" 2>&1`, { encoding: "utf8" });
      const authority = info.split("\n").find((l) => l.startsWith("Authority=")) || "";
      if (!authority.includes("Developer ID Application")) {
        console.error(`  FAIL app is not signed with a Developer ID cert: ${authority.trim() || "unsigned"}`);
        process.exit(1);
      }
      console.log(`  OK   signature valid: ${authority.replace("Authority=", "").trim()}`);
      const runtime = info.includes("flags=0x10000(runtime)") || info.includes("runtime");
      if (!runtime) {
        console.error("  FAIL hardened runtime missing; notarization would be rejected");
        process.exit(1);
      }
      console.log("  OK   hardened runtime enabled");
    } catch (error) {
      console.error(`  FAIL codesign verification failed: ${error.stderr?.toString().trim() || error.message}`);
      process.exit(1);
    }
  }
}

console.log(`  ..   submitting ${dmg} to Apple (this takes a few minutes)`);
try {
  const out = execFileSync(
    "xcrun",
    [
      "notarytool", "submit", dmgPath,
      "--key", KEY_PATH,
      "--key-id", KEY_ID,
      "--issuer", ISSUER_ID,
      "--wait",
      "--timeout", "30m",
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  console.log(out.trim().split("\n").slice(-6).join("\n"));
  if (!/status:\s*Accepted/i.test(out)) {
    console.error("  FAIL notarization was not Accepted");
    process.exit(1);
  }
} catch (error) {
  const detail = error.stdout?.toString() || error.stderr?.toString() || error.message;
  console.error(`  FAIL notarytool: ${detail.trim().slice(-800)}`);
  process.exit(1);
}

execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });

const mountPoint = mkdtempSync(join(tmpdir(), "oracle-notary-"));
let assessmentError = null;
try {
  execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath], {
    stdio: "pipe",
  });
  const mountedApp = readdirSync(mountPoint).find((file) => file.endsWith(".app"));
  if (!mountedApp) throw new Error("notarized DMG does not contain an app bundle");
  const result = spawnSync("spctl", ["--assess", "--type", "execute", "-vv", join(mountPoint, mountedApp)], {
    encoding: "utf8",
  });
  const assess = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0 || !/accepted/i.test(assess) || !/Notarized Developer ID/i.test(assess)) {
    throw new Error(`gatekeeper rejected the mounted app:\n${assess.trim()}`);
  }
} catch (error) {
  assessmentError = error;
} finally {
  spawnSync("hdiutil", ["detach", mountPoint], { stdio: "pipe" });
  rmSync(mountPoint, { recursive: true, force: true });
}

if (assessmentError) {
  console.error(`  FAIL ${assessmentError.message}`);
  process.exit(1);
}
console.log(`  OK   notarized, stapled, and accepted by Gatekeeper: ${dmg}`);
