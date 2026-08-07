import { spawnSync } from "node:child_process";
import path from "node:path";
export default {
  name: "route", summary: "swap/bridge prepare helpers", group: "read",
  usage: "oracle route <swap|bridge|prepare|prepare-bridge> ...",
  async run(ctx) {
    const bin = ctx.bin("oracle-route.mjs");
    const r = spawnSync(process.execPath, [bin, ...ctx.argv], { stdio: "inherit" });
    if (r.error) { process.stderr.write(`oracle: failed to spawn oracle-route: ${r.error.message}\n`); return 1; }
    return typeof r.status === "number" ? r.status : 1;
  },
};
