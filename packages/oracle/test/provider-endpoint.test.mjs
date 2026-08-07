// Provider endpoint pinning + Satflow body allowlist: adversarial cases.
//
// These encode the attacks Opus 5 and Grok reproduced against the pre-fix tree:
// a caller-controlled baseUrl exfiltrating the operator's API key, and a
// `body` object smuggling arbitrary fields into a marketplace intent.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveProviderEndpoint, credentialedHeaders } from "../src/data/provider-endpoint.mjs";

const DEFAULT = "https://api.example.com/v1";
const HOSTS = ["api.example.com"];

function resolve(url) {
  return resolveProviderEndpoint({ provider: "test", defaultUrl: DEFAULT, hosts: HOSTS, url });
}

test("the default endpoint is trusted", () => {
  const e = resolve(undefined);
  assert.equal(e.trusted, true);
  assert.equal(e.baseUrl, DEFAULT);
});

test("an allowlisted host is trusted", () => {
  assert.equal(resolve("https://api.example.com/v2").trusted, true);
});

test("an attacker host is NOT trusted and never receives the credential", () => {
  const e = resolve("https://attacker.example/v1");
  assert.equal(e.trusted, false);
  const h = credentialedHeaders({ accept: "application/json" }, { "x-api-key": "SECRET" }, e.trusted);
  assert.equal(h["x-api-key"], undefined, "the API key must not travel to a non-allowlisted host");
  assert.equal(h.accept, "application/json", "non-secret headers still apply");
});

test("a lookalike subdomain is not the allowlisted host", () => {
  for (const evil of [
    "https://api.example.com.attacker.test/v1",
    "https://attackerapi.example.com.evil/v1",
    "http://api.example.com@attacker.test/v1",
  ]) {
    assert.equal(resolve(evil).trusted, false, `${evil} must not be trusted`);
  }
});

test("a credential IS attached to a trusted host", () => {
  const e = resolve(undefined);
  const h = credentialedHeaders({}, { "x-api-key": "SECRET" }, e.trusted);
  assert.equal(h["x-api-key"], "SECRET");
});

test("an empty credential is never attached as an empty header", () => {
  const h = credentialedHeaders({}, { Authorization: "" }, true);
  assert.equal(h.Authorization, undefined);
});

test("a non-http protocol is rejected outright", () => {
  for (const bad of ["file:///etc/passwd", "ftp://x.test/a", "not-a-url"]) {
    assert.throws(() => resolve(bad), /absolute http/);
  }
});

test("the explicit operator override permits the host but still drops the key", () => {
  const saved = process.env.ORACLE_ALLOW_CUSTOM_PROVIDER_URL;
  process.env.ORACLE_ALLOW_CUSTOM_PROVIDER_URL = "1";
  try {
    const e = resolve("http://127.0.0.1:9999/v1");
    assert.equal(e.baseUrl, "http://127.0.0.1:9999/v1", "the override allows a local mock");
    assert.equal(e.trusted, false, "an override is not a reason to hand over the credential");
    assert.equal(credentialedHeaders({}, { "x-api-key": "SECRET" }, e.trusted)["x-api-key"], undefined);
  } finally {
    if (saved === undefined) delete process.env.ORACLE_ALLOW_CUSTOM_PROVIDER_URL;
    else process.env.ORACLE_ALLOW_CUSTOM_PROVIDER_URL = saved;
  }
});

test("satflow: the body branch cannot smuggle unknown fields to the venue", async () => {
  const { satflowPreparePurchase } = await import("../src/data/providers/satflow.mjs");
  let sent = null;
  await satflowPreparePurchase(
    {
      body: { arbitrary_field: "x", listing_id: "1", buyer_address: "bc1qgood" },
      maxSats: 100000,
    },
    {
      apiKey: "k",
      fetchImpl: async (_u, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ price: 5000, unsignedPSBTBase64: "cHNidP8" }) };
      },
    }
  );
  const keys = Object.keys(sent);
  assert.equal(keys.includes("arbitrary_field"), false, "unknown fields must not reach the venue");
  assert.equal(keys.includes("listing_id"), true, "legitimate fields must survive");
});

test("satflow: internal control fields never cross the boundary", async () => {
  const { satflowPreparePurchase } = await import("../src/data/providers/satflow.mjs");
  let sent = null;
  await satflowPreparePurchase(
    {
      body: { listing_id: "3", execute: true, apiKey: "LEAK", baseUrl: "https://evil", fetchImpl: "x", operator: "y" },
      maxSats: 100000,
    },
    {
      apiKey: "k",
      fetchImpl: async (_u, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ price: 5000 }) };
      },
    }
  );
  for (const leak of ["execute", "apiKey", "baseUrl", "fetchImpl", "operator", "maxSats"]) {
    assert.equal(Object.keys(sent).includes(leak), false, `${leak} must not reach the venue`);
  }
});

test("satflow: hostile prototype keys do not cross and do not pollute", async () => {
  const { satflowPreparePurchase } = await import("../src/data/providers/satflow.mjs");
  let sent = null;
  const hostile = JSON.parse('{"listing_id":"4","__proto__":{"polluted":true},"constructor":{"x":1}}');
  await satflowPreparePurchase(
    { body: hostile, maxSats: 100000 },
    {
      apiKey: "k",
      fetchImpl: async (_u, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ price: 5000 }) };
      },
    }
  );
  assert.equal(Object.keys(sent).includes("__proto__"), false);
  assert.equal({}.polluted, undefined, "Object.prototype must not be polluted");
});
