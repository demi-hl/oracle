#!/usr/bin/env node
// Bundle the package for publish so `src/` never ships.
//
// Every public entry point (package.json "exports" + "bin") becomes its own
// bundled file under dist/. Runtime dependencies stay external — we are hiding
// OUR source, not vendoring ethers into the tarball.
//
// This is obfuscation, not a security boundary. It raises the cost of lifting
// the provider/router/scanner work from "npm pack and read it" to "reverse a
// minified bundle". The real boundary is that the signer never ships at all.

import { build } from "esbuild";
import { cpSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const external = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
];

// src-relative entry -> dist-relative output, derived from the real manifest so
// a new export can never silently ship unbundled.
const entries = new Map();
for (const [name, target] of Object.entries(pkg.exports || {})) {
  if (typeof target !== "string" || !target.startsWith("./src/")) continue;
  entries.set(target.slice(2), distPathFor(target, "exports", name));
}
for (const [name, target] of Object.entries(pkg.bin || {})) {
  if (typeof target !== "string" || !target.startsWith("./bin/")) continue;
  entries.set(target.slice(2), distPathFor(target, "bin", name));
}

const commandDir = join(ROOT, "src", "cli", "commands");
for (const file of readdirSync(commandDir).filter((f) => f.endsWith(".mjs")).sort()) {
  entries.set(join("src", "cli", "commands", file), join("cli", "commands", file));
}

function distPathFor(target, kind, name) {
  const rel = target.replace(/^\.\/(src|bin)\//, "");
  return kind === "bin" ? join("bin", rel) : rel;
}

if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });

const results = [];
for (const [entry, outRel] of entries) {
  const outfile = join(DIST, outRel);
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    minify: true,
    legalComments: "none",
    external,
    logLevel: "error",
    // The CLI kernel loads user plugin files from disk at runtime; that import
    // is intentionally dynamic and must stay unresolved.
    // Bin entries already carry their own shebang in source — esbuild preserves
    // it, so adding a banner here would emit a second one on line 2 and break
    // the file. Only add it when the source genuinely lacks one.
    banner:
      outRel.startsWith("bin/") && !readFileSync(join(ROOT, entry), "utf8").startsWith("#!")
        ? { js: "#!/usr/bin/env node" }
        : undefined,
  });
  const bytes = readFileSync(outfile).byteLength;
  results.push({ entry, outRel, bytes });
}

// Rewrite the published manifest to point at dist/ and ship no source.
const out = structuredClone(pkg);
out.exports = Object.fromEntries(
  Object.entries(pkg.exports || {}).map(([k, v]) =>
    typeof v === "string" && v.startsWith("./src/")
      ? [k, "./dist/" + distPathFor(v, "exports", k)]
      : [k, v],
  ),
);
out.bin = Object.fromEntries(
  Object.entries(pkg.bin || {}).map(([k, v]) =>
    typeof v === "string" && v.startsWith("./bin/")
      ? [k, "./dist/" + distPathFor(v, "bin", k)]
      : [k, v],
  ),
);
// Ship the bundle and the user-facing assets. Never src/, scripts/, skills/,
// profiles/, docs/, examples/ — those are internal surface, not runtime need.
out.files = ["dist/", "public/", "artifacts/", "README.md", "SETUP.md", "LICENSE", "SECURITY.md"];
delete out.scripts;
delete out.devDependencies;

writeFileSync(join(DIST, "package.publish.json"), JSON.stringify(out, null, 2) + "\n");

// Runtime data the bins read from disk. esbuild bundles code, not JSON assets,
// so `oracle init` shipped without profiles/ and skills/ and crashed on ENOENT.
// They land under dist/assets/ and src/package-manifest.mjs looks there first.
const ASSET_DIRS = ["profiles", "skills"];
for (const name of ASSET_DIRS) {
  const from = join(ROOT, name);
  if (!existsSync(from)) continue;
  cpSync(from, join(DIST, "assets", name), { recursive: true });
}

const total = results.reduce((a, r) => a + r.bytes, 0);
console.log(`bundled ${results.length} entry points -> dist/  (${(total / 1024).toFixed(0)} KB)`);
for (const r of results.slice(0, 6)) {
  console.log(`  ${r.outRel.padEnd(34)} ${(r.bytes / 1024).toFixed(0)} KB`);
}
if (results.length > 6) console.log(`  ... ${results.length - 6} more`);
