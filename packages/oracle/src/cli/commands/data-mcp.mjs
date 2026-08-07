import path from "node:path";
import { spawnChild } from "../spawn-child.mjs";

export default {
  name: "data-mcp",
  summary: "start the read-only data MCP server",
  group: "read",
  usage: "oracle data-mcp",
  async run(ctx) {
    const bin = ctx.bin("oracle-data-mcp.mjs");
    return spawnChild(
      process.execPath,
      [bin, ...ctx.argv],
      { stdio: "inherit", env: process.env },
      "oracle-data-mcp",
    );
  },
};
