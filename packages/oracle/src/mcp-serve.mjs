/**
 * Lightweight JSON-RPC stdio MCP server loop.
 */
import { createInterface } from "node:readline";

export function fail(msg) {
  const e = new Error(msg);
  e.code = "ORACLE_MCP_ERROR";
  throw e;
}

export function serveMcp(server) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  let initialized = false;

  rl.on("line", (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }

    if (!request || request.jsonrpc !== "2.0") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "invalid request" } }) + "\n");
      return;
    }

    const respond = (result, rawValue = false) => {
      const response = { jsonrpc: "2.0", id: request.id ?? null };
      if (result instanceof Error) {
        response.error = { code: -32000, message: result.message };
      } else if (rawValue) {
        response.result = result;
      } else {
        response.result = result;
      }
      process.stdout.write(JSON.stringify(response) + "\n");
    };

    try {
      if (request.method === "initialize") {
        respond({ protocolVersion: request.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "oracle-exec", version: "1" } }, true);
        initialized = true;
        return;
      }
      if (request.method === "notifications/initialized") return;
      if (request.method === "ping") { respond({}, true); return; }
      if (request.method === "tools/list") { respond({ tools: server.tools }, true); return; }
      if (request.method === "tools/call") {
        const name = request.params?.name;
        const args = request.params?.arguments ?? {};
        Promise.resolve(server.call(name, args))
          .then((value) => respond(value))
          .catch((err) => respond(err));
        return;
      }
      respond(new Error(`method not found: ${request.method}`));
    } catch (err) {
      respond(err);
    }
  });

  rl.on("close", () => process.exit(0));
}