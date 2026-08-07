import { spawnSync } from "node:child_process";
import path from "node:path";
export default {
  name: "upgrade", summary: "upgrade installed Hermes lanes", group: "read",
  usage: "oracle upgrade [--apply ...]",
  async run(ctx) {
    const bin = ctx.bin("oracle-upgrade.mjs");
    const r = spawnSync(process.execPath, [bin, ...ctx.argv], { stdio: "inherit" });
    if (r.error) { process.stderr.write(`oracle: failed to spawn oracle-upgrade: ${r.error.message}\n`); return 1; }
    return typeof r.status === "number" ? r.status : 1;
  },
};
