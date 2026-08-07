// Regression tests for two data-plane HTTP flaws found in pre-public red team.
//
// 1. CROSS-TENANT CACHE LEAK: the single-flight dedupe key recorded only whether
//    an auth header was PRESENT, not its value. Two callers with different API
//    keys hitting the same URL collapsed into one upstream request, so caller B
//    received data fetched with caller A's credential.
//
// 2. UNSAFE NON-IDEMPOTENT REPLAY: a connection-level failure (no HTTP status)
//    was treated as retryable for every method, so a POST whose response was
//    lost in flight got replayed. The server may have already processed it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { httpJson } from "../src/data/http.mjs";

function respond(bodyForKey) {
  return async (url, init = {}) => {
    const key = init.headers?.["x-api-key"] ?? init.headers?.Authorization ?? "anon";
    await new Promise((r) => setTimeout(r, 15));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ servedFor: bodyForKey(key) }),
    };
  };
}

test("two callers with DIFFERENT api keys never share a deduped response", async () => {
  let upstream = 0;
  const fetchImpl = async (url, init = {}) => {
    upstream++;
    const key = init.headers["x-api-key"];
    await new Promise((r) => setTimeout(r, 15));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ servedFor: key }),
    };
  };

  const url = `https://example.test/tenant-${Math.random()}`;
  const [a, b] = await Promise.all([
    httpJson(url, { fetchImpl, headers: { "x-api-key": "key-alice" } }),
    httpJson(url, { fetchImpl, headers: { "x-api-key": "key-bob" } }),
  ]);

  assert.equal(a.servedFor, "key-alice", "alice must receive her own upstream response");
  assert.equal(b.servedFor, "key-bob", "bob must NOT receive alice's response");
  assert.equal(upstream, 2, "different credentials must produce separate upstream calls");
});

test("bearer tokens are also isolated, not collapsed by presence alone", async () => {
  let upstream = 0;
  const fetchImpl = async (url, init = {}) => {
    upstream++;
    const key = init.headers.Authorization;
    await new Promise((r) => setTimeout(r, 15));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ servedFor: key }) };
  };
  const url = `https://example.test/bearer-${Math.random()}`;
  const [a, b] = await Promise.all([
    httpJson(url, { fetchImpl, headers: { Authorization: "Bearer alice" } }),
    httpJson(url, { fetchImpl, headers: { Authorization: "Bearer bob" } }),
  ]);
  assert.equal(a.servedFor, "Bearer alice");
  assert.equal(b.servedFor, "Bearer bob");
  assert.equal(upstream, 2);
});

test("an anonymous caller never receives a keyed caller's response", async () => {
  let upstream = 0;
  const fetchImpl = async (url, init = {}) => {
    upstream++;
    const key = init.headers["x-api-key"] ?? "anon";
    await new Promise((r) => setTimeout(r, 15));
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ servedFor: key }) };
  };
  const url = `https://example.test/mixed-${Math.random()}`;
  const [keyed, anon] = await Promise.all([
    httpJson(url, { fetchImpl, headers: { "x-api-key": "key-alice" } }),
    httpJson(url, { fetchImpl }),
  ]);
  assert.equal(keyed.servedFor, "key-alice");
  assert.equal(anon.servedFor, "anon", "an unauthenticated caller must not inherit keyed data");
  assert.equal(upstream, 2);
});

test("identical credentials still dedupe (the optimization survives the fix)", async () => {
  let upstream = 0;
  const fetchImpl = respond(() => {
    upstream++;
    return "same";
  });
  const url = `https://example.test/same-${Math.random()}`;
  await Promise.all([
    httpJson(url, { fetchImpl, headers: { "x-api-key": "key-alice" } }),
    httpJson(url, { fetchImpl, headers: { "x-api-key": "key-alice" } }),
    httpJson(url, { fetchImpl, headers: { "x-api-key": "key-alice" } }),
  ]);
  assert.equal(upstream, 1, "same credential + same URL must still collapse to one call");
});

test("the dedupe key never stores a raw credential value", async () => {
  const mod = await import("../src/data/http.mjs");
  // The module must not expose its cache, and the key derivation must hash.
  assert.equal(mod.inflight, undefined, "the in-flight map must not be exported");
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/data/http.mjs", import.meta.url), "utf8")
  );
  assert.equal(
    /`\$\{method\} \$\{url\} \$\{headers\[/.test(src),
    false,
    "the cache key must not interpolate header values directly"
  );
  assert.ok(/createHash|hash/i.test(src), "credential material in the key must be hashed");
});

test("a connection-level failure does NOT replay a POST", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const err = new Error("socket hang up");
    err.name = "FetchError";
    throw err;
  };
  await assert.rejects(
    () => httpJson("https://example.test/post-replay", { fetchImpl, method: "POST", body: { a: 1 }, retries: 3 }),
    /socket hang up/
  );
  assert.equal(calls, 1, "a POST whose response was lost must not be resent");
});

test("a connection-level failure still retries an idempotent GET", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls < 3) {
      const err = new Error("socket hang up");
      err.name = "FetchError";
      throw err;
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ ok: true }) };
  };
  const out = await httpJson("https://example.test/get-retry", { fetchImpl, retries: 3, dedupe: false });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 3);
});

test("a POST still retries when the SERVER explicitly rejected it", async () => {
  // 429/503 means the server refused to process the request, so replay is safe.
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) {
      return { ok: false, status: 429, headers: { get: () => "0" }, text: async () => "{}" };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ ok: true }) };
  };
  const out = await httpJson("https://example.test/post-429", { fetchImpl, method: "POST", body: { a: 1 } });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 2);
});


test("credential headers are never replayed across a cross-origin redirect", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers || {}) }, redirect: init.redirect });
    if (calls.length === 1) {
      if (init.redirect !== "manual") {
        return fetchImpl("https://attacker.example/leak", init);
      }
      return {
        ok: false,
        status: 302,
        headers: { get: (name) => (String(name).toLowerCase() === "location" ? "https://attacker.example/leak" : null) },
        text: async () => "",
      };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ ok: true }) };
  };

  const out = await httpJson("https://api.example.test/account", {
    fetchImpl,
    headers: { Authorization: "Bearer SECRET", "x-api-key": "KEY" },
    dedupe: false,
  });

  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, "Bearer SECRET");
  assert.equal(calls[0].headers["x-api-key"], "KEY");
  assert.equal(calls[1].url, "https://attacker.example/leak");
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].headers["x-api-key"], undefined);
});
