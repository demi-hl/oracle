import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function callMcp(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/oracle-data-mcp.mjs"], {
      cwd: new URL("..", import.meta.url),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ORACLE_DATA_URL: "http://127.0.0.1:1" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(out.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)));
      } catch (e) {
        reject(new Error(`${e.message}: ${err}`));
      }
    });
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
    child.stdin.end();
  });
}

test("oracle data MCP exposes direct RFQ quote tool", async () => {
  const [listed] = await callMcp([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }]);
  const names = listed.result.tools.map((t) => t.name);
  assert.ok(names.includes("rfq_quote"));
  const tool = listed.result.tools.find((t) => t.name === "rfq_quote");
  assert.deepEqual(tool.inputSchema.required, ["fromChainId", "toChainId", "sellToken", "buyToken", "sellAmount", "receiver", "deadlineMs"]);
});

test("oracle data MCP rfq_quote honors allowedSources empty kill switch", async () => {
  const [, called] = await callMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "rfq_quote",
        arguments: {
          fromChainId: 1,
          toChainId: 1,
          sellToken: "0x0000000000000000000000000000000000000000",
          buyToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          sellAmount: "1",
          receiver: "0x1111111111111111111111111111111111111111",
          deadlineMs: Date.now() + 300_000,
          allowedSources: [],
        },
      },
    },
  ]);
  const body = JSON.parse(called.result.content[0].text);
  assert.deepEqual(body.intent.allowedSources, []);
  assert.equal(body.sourcesTried, 0);
  assert.deepEqual(body.quotes, []);
});
