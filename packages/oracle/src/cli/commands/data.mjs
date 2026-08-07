import path from "node:path";
import { parseArgs } from "node:util";
import { spawnChild } from "../spawn-child.mjs";

const DEFAULT_DATA_URL = "http://127.0.0.1:8787";

function usage() {
  process.stderr.write(
    "usage: oracle data <serve|call|catalog|health> [args]\n" +
      "  oracle data serve [--port N]\n" +
      "  oracle data call <provider> <op> [--args '<json>']\n" +
      "  oracle data catalog\n" +
      "  oracle data health\n",
  );
}

async function dataFetch(pathname, { method = "GET", body } = {}) {
  const base = (process.env.ORACLE_DATA_URL || DEFAULT_DATA_URL).replace(/\/$/, "");
  const url = base + pathname;
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    return res.ok ? 0 : 1;
  } catch (err) {
    if (err && (err.code === "ECONNREFUSED" || /fetch failed|ECONNREFUSED/i.test(String(err)))) {
      process.stderr.write("oracle: data server not running — start it with 'oracle data serve'\n");
      return 4;
    }
    process.stderr.write(`oracle data: ${err.message || err}\n`);
    return 1;
  }
}

export default {
  name: "data", summary: "desk data plane", group: "read",
  usage: "oracle data serve|call|catalog|health",
  async run(ctx) {
    const verb = ctx.argv[0];
    if (!verb || verb === "--help" || verb === "-h") { usage(); return verb ? 0 : 1; }
    if (verb === "serve") {
      let port = null;
      try {
        const { values } = parseArgs({ args: ctx.argv.slice(1), options: { port: { type: "string" } }, allowPositionals: true, strict: false });
        port = values.port || null;
      } catch {}
      const env = { ...process.env };
      if (port) env.ORACLE_DATA_PORT = String(port);
      const bin = ctx.bin("desk-server.mjs");
      return spawnChild(process.execPath, [bin], { stdio: "inherit", env }, "desk-server");
    }
    // The server serves /health; / intentionally 404s with a route list. This
    // probed / and so reported the package's own running server as down.
    if (verb === "health") return dataFetch("/health");
    if (verb === "catalog") return dataFetch("/data/catalog");
    if (verb === "call") {
      const provider = ctx.argv[1];
      const op = ctx.argv[2];
      if (!provider || !op) { usage(); return 1; }
      let argsObj = {};
      const i = ctx.argv.indexOf("--args");
      if (i >= 0) {
        try { argsObj = JSON.parse(ctx.argv[i + 1] || "{}"); }
        catch (err) { process.stderr.write(`oracle data call: invalid --args JSON: ${err.message}\n`); return 1; }
      }
      return dataFetch("/data/call", { method: "POST", body: { provider, op, args: argsObj } });
    }
    usage();
    return 1;
  },
};
