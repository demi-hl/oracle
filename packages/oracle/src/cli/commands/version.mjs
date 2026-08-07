import fs from "node:fs";
import path from "node:path";
import { resolveOperator } from "../operator-dispatch.mjs";

export default {
  name: "version",
  summary: "print oracle (and operator, if present) version",
  group: "meta",
  usage: "oracle version",
  async run(ctx) {
    let version = "0.0.0";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ctx.root, "package.json"), "utf8"));
      version = pkg.version || version;
    } catch {}
    let line = `oracle ${version}`;
    const op = (ctx.resolveOperator || resolveOperator)();
    if (op.ok) line += `  operator ${op.version}`;
    process.stdout.write(line + "\n");
    return 0;
  },
};
