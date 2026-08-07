// Data-plane HTTP hardening: retry, single-flight dedupe, bounded fan-out.
//
// These are the optimizations a self-hoster feels immediately — public venue
// APIs rate limit hard, and an unbounded health sweep looks like an outage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { httpJson, mapLimit } from "../src/data/http.mjs";

function res(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("httpJson retries a 429 and then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return res(429, { error: "slow down" }, { "retry-after": "0" });
    return res(200, { ok: true });
  };
  const out = await httpJson("https://example.test/a", { fetchImpl, dedupe: false });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 2);
});

test("httpJson does NOT retry a 400 class client error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return res(400, { error: "bad request" });
  };
  await assert.rejects(() => httpJson("https://example.test/b", { fetchImpl, dedupe: false }), /HTTP 400/);
  assert.equal(calls, 1, "a 400 must not be retried");
});

test("httpJson gives up after the retry budget and surfaces the last error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return res(503, { error: "down" }, { "retry-after": "0" });
  };
  await assert.rejects(() => httpJson("https://example.test/c", { fetchImpl, retries: 2, dedupe: false }), /HTTP 503/);
  assert.equal(calls, 3, "one initial attempt plus two retries");
});

test("httpJson retries=0 disables retry entirely", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return res(429, { error: "slow down" }, { "retry-after": "0" });
  };
  await assert.rejects(() => httpJson("https://example.test/d", { fetchImpl, retries: 0, dedupe: false }), /HTTP 429/);
  assert.equal(calls, 1);
});

test("concurrent identical GETs collapse into ONE upstream call", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 15));
    return res(200, { n: calls });
  };
  const url = `https://example.test/dedupe-${Math.random()}`;
  const [a, b, c] = await Promise.all([
    httpJson(url, { fetchImpl }),
    httpJson(url, { fetchImpl }),
    httpJson(url, { fetchImpl }),
  ]);
  assert.equal(calls, 1, "three concurrent identical GETs must cost one upstream call");
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("dedupe does not leak across different URLs", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return res(200, { n: calls });
  };
  const salt = Math.random();
  await Promise.all([
    httpJson(`https://example.test/x-${salt}`, { fetchImpl }),
    httpJson(`https://example.test/y-${salt}`, { fetchImpl }),
  ]);
  assert.equal(calls, 2);
});

test("POST bodies are never deduped", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return res(200, { n: calls });
  };
  const url = `https://example.test/post-${Math.random()}`;
  await Promise.all([
    httpJson(url, { fetchImpl, method: "POST", body: { a: 1 } }),
    httpJson(url, { fetchImpl, method: "POST", body: { a: 1 } }),
  ]);
  assert.equal(calls, 2, "writes/queries with bodies must stay independent");
});

test("dedupe releases the slot so a later call re-fetches", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return res(200, { n: calls });
  };
  const url = `https://example.test/seq-${Math.random()}`;
  await httpJson(url, { fetchImpl });
  await httpJson(url, { fetchImpl });
  assert.equal(calls, 2);
});

test("mapLimit respects the concurrency ceiling and preserves order", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const out = await mapLimit(items, 4, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.ok(peak <= 4, `peak concurrency ${peak} exceeded the ceiling`);
  assert.deepEqual(out, items.map((n) => n * 2));
});

test("mapLimit handles an empty list without hanging", async () => {
  assert.deepEqual(await mapLimit([], 8, async (x) => x), []);
});
