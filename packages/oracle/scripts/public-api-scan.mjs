#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { scanPublicApis } from "../src/data/public-api-scan.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const outPath = value("--out");
const timeoutMs = Number(value("--timeout-ms") || 12_000);
const providers = value("--providers")?.split(",").map((x) => x.trim()).filter(Boolean);

const report = await scanPublicApis({ providers, timeoutMs });
const json = `${JSON.stringify(report, null, 2)}\n`;
if (outPath) {
  const target = path.resolve(outPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, json, "utf8");
  console.error(`wrote ${target}`);
}
process.stdout.write(json);
