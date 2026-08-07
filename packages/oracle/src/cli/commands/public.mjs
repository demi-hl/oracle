import path from "node:path";
import { parseArgs } from "node:util";
import { spawnChild } from "../spawn-child.mjs";
export default {
  name: "public", summary: "secret-free public HTTP surface", group: "read",
  usage: "oracle public serve [--port N]",
  async run(ctx) {
    const verb = ctx.argv[0] || "serve";
    if (verb !== "serve") { process.stderr.write("usage: oracle public serve [--port N]\n"); return 1; }
    let port = null;
    try {
      const { values } = parseArgs({ args: ctx.argv.slice(1), options: { port: { type: "string" } }, allowPositionals: true, strict: false });
      port = values.port || null;
    } catch {}
    const env = { ...process.env };
    if (port) env.ORACLE_PUBLIC_PORT = String(port);
    const bin = ctx.bin("oracle-public-server.mjs");
    return spawnChild(process.execPath, [bin], { stdio: "inherit", env }, "oracle-public-server");
  },
};
