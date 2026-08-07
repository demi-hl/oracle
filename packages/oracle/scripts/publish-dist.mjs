#!/usr/bin/env node
// Stage and publish the BUNDLED package.
//
// Publishing from packages/oracle directly would ship src/ (36k readable lines).
// This builds dist/, verifies export parity against source, stages a clean
// directory with a rewritten manifest, and publishes from there. The source
// tree is never the thing that gets packed.
//
//   node scripts/publish-dist.mjs            # pack only, leaves the tarball
//   node scripts/publish-dist.mjs --publish  # actually publish to npm

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = join(ROOT, ".publish-stage");
const doPublish = process.argv.includes("--publish");

const run = (cmd, args, cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env } });

console.log("→ building bundle");
run("node", [join(ROOT, "scripts/build-dist.mjs")]);

console.log("→ verifying export parity against source");
run("node", [join(ROOT, "scripts/verify-dist.mjs")]);

console.log("→ staging");
if (existsSync(STAGE)) rmSync(STAGE, { recursive: true });
mkdirSync(STAGE, { recursive: true });

const manifest = JSON.parse(readFileSync(join(ROOT, "dist/package.publish.json"), "utf8"));
cpSync(join(ROOT, "dist"), join(STAGE, "dist"), { recursive: true });
rmSync(join(STAGE, "dist/package.publish.json"), { force: true });

for (const asset of ["public", "artifacts"]) {
  if (existsSync(join(ROOT, asset))) {
    cpSync(join(ROOT, asset), join(STAGE, asset), { recursive: true });
  }
}
for (const doc of ["README.md", "SETUP.md", "LICENSE", "SECURITY.md"]) {
  if (existsSync(join(ROOT, doc))) cpSync(join(ROOT, doc), join(STAGE, doc));
}
writeFileSync(join(STAGE, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

// Fail closed: if source somehow reached the stage, do not publish it.
const leaked = [];
for (const forbidden of ["src", "scripts", "skills", "profiles", "test"]) {
  if (existsSync(join(STAGE, forbidden))) leaked.push(forbidden);
}
if (leaked.length) {
  console.error(`\nREFUSING: source directories reached the publish stage: ${leaked.join(", ")}`);
  process.exit(1);
}

// Export parity proves the modules exist. It does NOT prove a bin can start:
// 0.12.0 passed parity and still shipped two bins that crashed on first line
// because they resolved assets relative to the wrong layout. Smoke the stage.
console.log("→ smoking staged bins");
run("node", [join(ROOT, "scripts/smoke-dist-bins.mjs"), STAGE]);

console.log(doPublish ? "→ publishing" : "→ packing (dry, no publish)");
run("npm", doPublish ? ["publish", "--access", "public"] : ["pack"], STAGE);

console.log(`\n${doPublish ? "published" : "packed"} from ${STAGE}`);
