// Data plane must be mechanically read/quote/prepare only.
// HTTP route regexes are not a boundary; the core dispatcher has to reject
// write-shaped operations and nested RPC method smuggling directly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { dataCall, dataCatalog } from "../src/data/desk-data.mjs";

test("dataCall rejects nested JSON-RPC write/broadcast method smuggling", async () => {
  await assert.rejects(
    dataCall(
      "evm-rpc",
      "call",
      { chainId: 8453, method: "eth_sendRawTransaction", params: [`0x${"12".repeat(32)}`] },
      { rpcUrl: "http://rpc.local", fetchImpl: async () => { throw new Error("should not fetch"); } },
    ),
    /read-only JSON-RPC method/i,
  );
});

test("data catalog and dataCall do not expose write-shaped ops", async () => {
  const dangerous = /sign|execute|broadcast|submit|place|send|write/i;
  const leaked = [];
  for (const p of dataCatalog()) {
    for (const op of p.ops || []) {
      if (dangerous.test(op)) leaked.push(`${p.id}.${op}`);
    }
  }
  assert.deepEqual(leaked, [], `write-shaped ops leaked from data catalog:\n  ${leaked.join("\n  ")}`);

  const exec = dataCatalog().find((p) => p.id === "hl-exec");
  assert.equal(exec, undefined, "hl-exec must not be registered on the public data plane");
  for (const p of dataCatalog()) {
    assert.notEqual(p.execution, "live", `${p.id} must not claim live execution`);
  }

  await assert.rejects(
    dataCall("satflow", "broadcastPurchase", { execute: true, signed_psbt: "deadbeef" }, { fetchImpl: async () => { throw new Error("should not fetch"); } }),
    /does not support|forbidden/i,
  );
  await assert.rejects(
    dataCall("defillama", "sendPrices", {}, { fetchImpl: async () => { throw new Error("should not fetch"); } }),
    /forbidden/i,
  );
  await assert.rejects(
    dataCall("defillama", "writePrices", {}, { fetchImpl: async () => { throw new Error("should not fetch"); } }),
    /forbidden/i,
  );
});
