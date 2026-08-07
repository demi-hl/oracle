import { spawnSync } from "node:child_process";
import path from "node:path";
export default {
  name: "prepare", summary: "build an unsigned swap (alias of route prepare)", group: "read",
  usage: "oracle prepare <chain> <tokenIn> <tokenOut> <taker> [amt]",
  async run(ctx) {
    const bin = ctx.bin("oracle-route.mjs");
    const r = spawnSync(process.execPath, [bin, "prepare", ...ctx.argv], { stdio: "inherit" });
    if (r.error) { process.stderr.write(`oracle: failed to spawn oracle-route: ${r.error.message}\n`); return 1; }
    return typeof r.status === "number" ? r.status : 1;
  },
};
