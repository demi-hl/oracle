// Public-plane rate limiting — abuse resistance for an unauthenticated surface.
//
// /public/approvals fans one request out to many upstream RPC calls, so an
// unthrottled loop burns the shared public-RPC quota and the service itself.
// These tests pin the two properties that matter: the amplifying route is held
// to a strict ceiling, and a spoofable proxy header cannot mint a fresh
// identity per request to escape it.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/public-api/http.mjs"),
  "utf8",
);

beforeEach(() => {});

test("the amplifying route has a strictly lower ceiling than cheap reads", () => {
  const strict = /RATE_LIMIT_AMPLIFYING\s*=\s*(\d+)/.exec(SRC);
  const loose = /RATE_LIMIT_DEFAULT\s*=\s*(\d+)/.exec(SRC);
  assert.ok(strict && loose, "both ceilings must be defined");
  assert.ok(
    Number(strict[1]) < Number(loose[1]),
    "an RPC-amplifying route must be limited more aggressively than a cheap read",
  );
});

test("the approvals route is registered as amplifying", () => {
  assert.match(SRC, /AMPLIFYING_ROUTES[\s\S]{0,120}\/public\/approvals/);
});

test("proxy headers are only trusted behind an explicit opt-in", () => {
  // A spoofable X-Forwarded-For would let any client reset its own counter.
  assert.match(SRC, /ORACLE_TRUST_PROXY/);
  const fn = SRC.slice(SRC.indexOf("function clientKey"));
  const guardAt = fn.indexOf("ORACLE_TRUST_PROXY");
  const headerAt = fn.indexOf("x-forwarded-for");
  assert.ok(guardAt !== -1 && headerAt !== -1);
  assert.ok(guardAt < headerAt, "the opt-in must be checked before the header is read");
});

test("a limited request answers 429 with a retry hint", () => {
  assert.match(SRC, /writeHead\(429/);
  assert.match(SRC, /"retry-after"/);
  assert.match(SRC, /rate-limited/);
});

test("the limiter is bounded so it cannot grow with traffic", () => {
  assert.match(SRC, /MAX_RATE_ENTRIES/);
  assert.match(SRC, /rateBuckets\.delete/);
});

test("chain fan-out per request is capped", () => {
  assert.match(SRC, /MAX_CHAINS_PER_REQUEST\s*=\s*\d+/);
  assert.match(SRC, /too-many-chains/);
});

test("the limiter runs before the request body is read", () => {
  const handler = SRC.slice(SRC.indexOf("async function handleRequest"));
  const gateAt = handler.indexOf("rateLimit(req");
  const bodyAt = handler.indexOf("readJsonBody(req)");
  assert.ok(gateAt !== -1 && bodyAt !== -1);
  assert.ok(gateAt < bodyAt, "a limited caller must not be able to make us parse a body");
});
