// D0 data plane tests — mocked fetch only (no network required).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listProviders, getProvider, registerProvider, clearProvidersForTest } from "../src/data/catalog.mjs";
// Re-import catalog side effects: built-ins register on load. clearProvidersForTest wipes them —
// so tests that need built-ins must not clear, or we re-import. Prefer not clearing built-ins.
import { data, dataCall, dataHealth, dataCatalog } from "../src/data/desk-data.mjs";
import { hlHealth, hlAllMids, hlL2Book } from "../src/data/providers/hl-info.mjs";
import { polyHealth, polyMarkets, polyBook } from "../src/data/providers/poly-public.mjs";
import { rhHealth, rhPolicy } from "../src/data/providers/rh-agent.mjs";

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(obj),
  };
}

test("catalog lists core providers; auth is a known mode", () => {
  const cat = dataCatalog();
  const ids = cat.map((p) => p.id);
  for (const need of ["hl-info", "poly-public", "rh-agent"]) {
    assert.ok(ids.includes(need), `missing ${need}`);
  }
  // optionalApiKey = provider works keyless in a degraded mode (e.g. bitcoin-meta
  // returns tip-only without an indexer key) and unlocks more ops once keyed.
  const AUTH_MODES = ["none", "apiKey", "optionalApiKey", "agentKey"];
  for (const p of cat) {
    assert.ok(AUTH_MODES.includes(p.auth), `${p.id} bad auth ${p.auth}`);
    assert.ok(p.ops.includes("health"), `${p.id} missing health`);
  }
  assert.equal(getProvider("hl-info").venue, "hl");
  assert.equal(getProvider("poly-public").chainIds.includes(137), true);
  assert.equal(getProvider("zerox")?.auth, "apiKey");
});

test("registerProvider extends catalog at runtime", () => {
  registerProvider({
    id: "test-dex",
    venue: "evm",
    chainIds: [1],
    auth: "none",
    ops: ["health", "quote"],
  });
  assert.ok(listProviders().some((p) => p.id === "test-dex"));
  assert.ok(listProviders({ venue: "evm" }).some((p) => p.id === "test-dex"));
});

test("registerProvider cannot overwrite a built-in provider", () => {
  const before = getProvider("lifi");
  assert.ok(before, "expected built-in lifi provider");

  assert.throws(
    () => registerProvider({
      id: "lifi",
      venue: "evil",
      chainIds: [1],
      auth: "none",
      ops: ["health", "quote"],
      execution: "write",
    }),
    /built-in provider/i,
  );

  assert.equal(getProvider("lifi").venue, before.venue);
  assert.equal(getProvider("lifi").execution, before.execution);
});

test("hl-info allMids + health via mock fetch", async () => {
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /hyperliquid|info/i);
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.type, "allMids");
    return jsonResponse({ BTC: "65000", ETH: "3500" });
  };
  const mids = await hlAllMids({ fetchImpl });
  assert.equal(mids.BTC, "65000");
  const h = await hlHealth({ fetchImpl });
  assert.equal(h.ok, true);
  assert.equal(h.midCount, 2);
});

test("hl l2Book requires coin", async () => {
  await assert.rejects(hlL2Book(undefined, { fetchImpl: async () => jsonResponse({}) }), /coin/i);
});

test("poly public time/health/markets/book via mock", async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("/time")) return jsonResponse(1_700_000_000);
    if (u.includes("/markets")) return jsonResponse([{ id: "m1", question: "test?" }]);
    if (u.includes("/book")) return jsonResponse({ bids: [], asks: [] });
    return { ok: false, status: 404, text: async () => "no" };
  };
  const h = await polyHealth({ fetchImpl });
  assert.equal(h.ok, true);
  const markets = await polyMarkets({ limit: 1 }, { fetchImpl });
  assert.equal(markets[0].id, "m1");
  const book = await polyBook("token-123", { fetchImpl });
  assert.ok(Array.isArray(book.bids));
});

test("rh health + policy via mock", async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith("/api/health")) return jsonResponse({ ok: true, service: "rh-agent" });
    if (u.endsWith("/api/agent/policy")) return jsonResponse({ executeEnabled: false });
    return { ok: false, status: 404, text: async () => "no" };
  };
  const health = await rhHealth({ fetchImpl });
  assert.equal(health.ok, true);
  const policy = await rhPolicy({ fetchImpl });
  assert.equal(policy.executeEnabled, false);
});

test("dataCall routes provider.op and rejects unknown op", async () => {
  const fetchImpl = async () => jsonResponse({ BTC: "1" });
  const mids = await dataCall("hl-info", "allMids", {}, { fetchImpl });
  assert.equal(mids.BTC, "1");
  await assert.rejects(dataCall("hl-info", "drain", {}, { fetchImpl }), /does not support/i);
  await assert.rejects(dataCall("nope", "health", {}), /unknown data provider/i);
});

test("data.hl / data.poly / data.rh convenience API", async () => {
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes("hyperliquid") || (init && init.method === "POST")) {
      return jsonResponse({ SOL: "100" });
    }
    if (u.includes("/time")) return jsonResponse(42);
    if (u.includes("/api/health")) return jsonResponse({ status: "up" });
    return jsonResponse({});
  };
  assert.equal((await data.hl.allMids({ fetchImpl })).SOL, "100");
  assert.equal(await data.poly.time({ fetchImpl }), 42);
  assert.equal((await data.rh.health({ fetchImpl })).status, "up");
});

test("dataHealth aggregates provider health; plane is data not exec", async () => {
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes("hyperliquid") || init?.method === "POST") {
      // HL info POST or JSON-RPC
      if (init?.body && String(init.body).includes("eth_")) {
        const body = JSON.parse(init.body);
        if (body.method === "eth_blockNumber")
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" });
        if (body.method === "eth_chainId")
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" });
      }
      return jsonResponse({ A: "1", B: "2" });
    }
    if (u.includes("/time")) return jsonResponse(99);
    if (u.includes("/api/health")) return jsonResponse({ ok: true });
    if (u.includes("coins.llama") || u.includes("prices/current"))
      return jsonResponse({ coins: { "coingecko:ethereum": { price: 1 } } });
    return jsonResponse({});
  };
  const report = await dataHealth({
    fetchImpl,
    providers: ["hl-info", "poly-public", "rh-agent", "defillama", "evm-rpc"],
  });
  assert.equal(report.plane, "data");
  assert.equal(report.exec, false);
  assert.equal(report.providers["hl-info"].ok, true);
  assert.equal(report.providers["poly-public"].ok, true);
  assert.equal(report.providers["rh-agent"].ok, true);
  assert.equal(report.providers["defillama"].ok, true);
  assert.equal(report.providers["evm-rpc"].ok, true);
});

test("dataHealth records failure without throwing", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const report = await dataHealth({
    providers: ["hl-info"],
    fetchImpl,
    timeoutMs: 500,
  });
  assert.equal(report.providers["hl-info"].ok, false);
  assert.match(report.providers["hl-info"].error, /network down/i);
});
