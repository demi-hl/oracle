import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const appDir = join(root, "apps/oracle-app");
const standalone = join(appDir, ".next/standalone");
const staged = join(root, "apps/oracle-desktop/runtime/oracle-app");
const stagedApp = join(staged, "apps/oracle-app");

if (!existsSync(standalone)) {
  throw new Error("missing Next standalone build. Run npm --workspace @oracle-agent/app run build:desktop first.");
}

rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });
cpSync(standalone, staged, { recursive: true });
cpSync(join(appDir, ".next/static"), join(stagedApp, ".next/static"), { recursive: true });
cpSync(join(appDir, "public"), join(stagedApp, "public"), { recursive: true });

// Next 16's Turbopack standalone trace omits .next/server/chunks, and every
// compiled route requires ../../../chunks/[turbopack]_runtime.js at load time.
// Without this copy the staged server boots, reports Ready, then answers 500
// with MODULE_NOT_FOUND on the first request — the shape that looks like a
// broken app rather than an incomplete bundle.
const chunks = join(appDir, ".next/server/chunks");
if (existsSync(chunks)) {
  cpSync(chunks, join(stagedApp, ".next/server/chunks"), {
    recursive: true,
    filter: (src) => !src.endsWith(".map"),
  });
}

const server = join(stagedApp, "server.js");
if (!existsSync(server)) throw new Error(`standalone build did not produce ${server}`);

const runtime = readdirSync(join(stagedApp, ".next/server/chunks")).filter((f) => f.includes("runtime"));
if (runtime.length === 0) throw new Error("staged runtime is missing the Turbopack server runtime chunk");

console.log(`staged Next runtime at ${staged}`);
