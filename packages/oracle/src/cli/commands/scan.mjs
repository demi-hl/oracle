import { spawnSync } from "node:child_process";
import path from "node:path";
export default {
  name: "scan", summary: "chain scanner", group: "read",
  usage: "oracle scan <chains|head|token|pools|risk|quote|sell> ...",
  async run(ctx) {
    const bin = ctx.bin("oracle-scan.mjs");
    const r = spawnSync(process.execPath, [bin, ...ctx.argv], { stdio: "inherit" });
    if (r.error) { process.stderr.write(`oracle: failed to spawn oracle-scan: ${r.error.message}\n`); return 1; }
    return typeof r.status === "number" ? r.status : 1;
  },
};
