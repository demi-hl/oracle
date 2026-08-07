// Resolve this package's own root without assuming how deep the caller sits.
//
// Bin entry points run from `bin/` in the source tree and from `dist/bin/` in
// the published bundle, so a hard-coded `path.join(__dirname, "..")` is correct
// in exactly one layout. That is what broke 0.12.0: `oracle-data` and
// `oracle init` both crashed at startup with ENOENT because they resolved
// dist/package.json and dist/profiles/ instead of the real package root.
//
// Runtime assets (profiles/, skills/) live at the root in the source tree and
// under dist/assets/ in the bundle, so asset lookup checks both.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function packageRoot(fromUrl) {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        if (parsed && typeof parsed.version === "string") return dir;
      } catch {
        // an unreadable manifest is not the root we want; keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`oracle: could not resolve package root from ${fromUrl}`);
}

export function readPackageManifest(fromUrl) {
  return JSON.parse(readFileSync(join(packageRoot(fromUrl), "package.json"), "utf8"));
}

export function packageAssetDir(name, fromUrl) {
  const root = packageRoot(fromUrl);
  const bundled = join(root, "dist", "assets", name);
  return existsSync(bundled) ? bundled : join(root, name);
}
