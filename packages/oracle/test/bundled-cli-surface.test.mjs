// Bundled publish surface.
//
// The source CLI discovers commands from src/cli/commands at runtime. The
// publish build strips src/, so the bundled package must carry bundled command
// modules under dist/cli/commands and the kernel must look there when src/ is
// absent. Otherwise a clean npm install prints `Known: (none loaded yet)`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

test("publish build bundles CLI command modules", () => {
  const build = read("scripts/build-dist.mjs");
  assert.match(build, /src", "cli", "commands"/);
  assert.match(build, /join\("cli", "commands", file\)/);
});

test("CLI kernel loads bundled commands when source is absent", () => {
  const kernel = read("src/cli/kernel.mjs");
  assert.match(kernel, /src", "cli", "commands"/);
  assert.match(kernel, /dist", "cli", "commands"/);
  assert.match(kernel, /fs\.existsSync\(sourceDir\)/);
});
