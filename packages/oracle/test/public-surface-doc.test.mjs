// The public surface must stay documented.
//
// gpt-56's lane found 11 of 15 export subpaths, 2 of 8 bins, and 36 ORACLE_*
// env names with no literal mention in the shipped docs — including the
// execute/deploy arming flags. Parsed polarity was safe, so this is surface
// contract debt rather than an unsafe default, but an undocumented arming flag
// is exactly the thing an operator needs to be able to find.
//
// Asserted against package.json and the source rather than a hardcoded list,
// so adding an export/bin/flag without documenting it fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

function docText() {
  return ["README.md", "SETUP.md", "SECURITY.md", "docs/public-surface.md"]
    .map((f) => {
      try {
        return readFileSync(join(ROOT, f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

test("every export subpath is documented", () => {
  const docs = docText();
  const undocumented = Object.keys(pkg.exports || {})
    .filter((sub) => sub !== ".")
    .filter((sub) => !docs.includes(`@oracle-agent/oracle${sub.slice(1)}`));

  assert.deepEqual(
    undocumented,
    [],
    `export subpaths missing from the docs: ${undocumented.join(", ")} — ` +
      `if a subpath is meant to be internal, remove it from "exports" instead of shipping it undocumented`
  );
});

test("every shipped bin is documented", () => {
  const docs = docText();
  const undocumented = Object.keys(pkg.bin || {}).filter(
    (bin) => !new RegExp(`\\b${bin}\\b`).test(docs)
  );

  assert.deepEqual(
    undocumented,
    [],
    `executables missing from the docs: ${undocumented.join(", ")}`
  );
});

test("every ORACLE_* runtime variable is documented", () => {
  const docs = docText();
  const names = new Set();

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "test") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!p.endsWith(".mjs")) continue;
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/envFlag\(\s*["'`]?(ORACLE_[A-Z0-9_]+)/g)) names.add(m[1]);
      for (const m of src.matchAll(/env\(\s*"(ORACLE_[A-Z0-9_]+)"/g)) names.add(m[1]);
      for (const m of src.matchAll(/process\.env\.(ORACLE_[A-Z0-9_]+)/g)) names.add(m[1]);
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "bin"));

  const undocumented = [...names].sort().filter((n) => !docs.includes(n));

  assert.deepEqual(
    undocumented,
    [],
    `runtime environment variables missing from the docs: ${undocumented.join(", ")} — ` +
      `security-relevant modes especially must be findable by an operator`
  );
});

// The arming flags are the ones that decide whether anything can ever be
// signed. Their documented default must say OFF.
test("the arming flags are documented as default-off", () => {
  const surface = readFileSync(join(ROOT, "docs/public-surface.md"), "utf8");
  for (const flag of ["ORACLE_EXECUTE_ENABLED", "ORACLE_DEPLOY_ENABLED"]) {
    const row = surface.split("\n").find((line) => line.includes(flag));
    assert.ok(row, `${flag} must appear in the public surface doc`);
    assert.match(row, /\boff\b/i, `${flag} must be documented as default-off`);
  }
});
