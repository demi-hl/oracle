#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli/kernel.mjs";

export const COMMANDS = Object.freeze({
  data: "./desk-server.mjs",
  public: "./oracle-public-server.mjs",
  "data-mcp": "./oracle-data-mcp.mjs",
  init: "./oracle-init.mjs",
  upgrade: "./oracle-upgrade.mjs",
  scan: "./oracle-scan.mjs",
  route: "./oracle-route.mjs",
  equities: "./oracle-equities.mjs",
});

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  return run(argv);
}

if (isMainModule()) {
  const code = await main();
  process.exit(typeof code === "number" ? code : 0);
}
