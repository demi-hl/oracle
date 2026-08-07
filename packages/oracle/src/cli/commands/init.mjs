import { spawnSync } from "node:child_process";
import path from "node:path";
import { renderNextSteps } from "../first-run.mjs";

export default {
  name: "init",
  summary: "install agent lanes + read plane (dry-run by default)",
  group: "read",
  usage: "oracle init [--apply --force --only <lane> --json --yes]",
  async run(ctx) {
    const argv = [...ctx.argv];
    if (argv.includes("--yes") && !argv.includes("--apply")) argv.push("--apply");
    const bin = ctx.bin("oracle-init.mjs");
    const r = spawnSync(process.execPath, [bin, ...argv], { encoding: "utf8", env: process.env });
    if (r.error) {
      process.stderr.write(`oracle: failed to spawn oracle-init: ${r.error.message}\n`);
      return 1;
    }
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    const code = typeof r.status === "number" ? r.status : 1;
    if (code === 0 && argv.includes("--apply") && !argv.includes("--json")) {
      process.stdout.write(renderNextSteps());
    }
    return code;
  },
};
