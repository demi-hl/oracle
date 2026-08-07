#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upgradeProfiles } from "../src/profile-upgrade.mjs";

const argv = process.argv.slice(2);
const value = (flag) => {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${flag} requires a value`);
  return argv[index + 1];
};

try {
  const known = new Set(["--apply", "--json", "--only", "--hermes-home", "--package-root", "--control-command"]);
  for (let i = 0; i < argv.length; i += 1) {
    if (!known.has(argv[i])) throw new Error(`unknown option: ${argv[i]}`);
    if (["--only", "--hermes-home", "--package-root", "--control-command"].includes(argv[i])) i += 1;
  }
  const packageRoot = path.resolve(value("--package-root") || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const hermesHome = path.resolve(value("--hermes-home") || process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"));
  const control = value("--control-command");
  const result = upgradeProfiles({
    hermesHome,
    packageRoot,
    only: value("--only"),
    apply: argv.includes("--apply"),
    controlCommand: control ? control.trim().split(/\s+/) : null,
  });
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    console.log(`oracle-upgrade ${result.applied ? "applied" : "dry run"}: ${result.profiles.length} profile(s)`);
    for (const key of ["created", "updated", "unchanged", "backups"]) console.log(`${key}: ${result[key].length}`);
    if (!result.applied) console.log("Re-run with --apply to make these changes.");
  }
} catch (error) {
  const failure = { ok: false, error: error.message };
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
  else console.error(`oracle-upgrade: ${error.message}`);
  process.exitCode = 1;
}
