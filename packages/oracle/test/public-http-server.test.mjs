// Slice G — public HTTP server (BFF) contract tests.
//
// Boots the REAL server (bin/oracle-public-server.mjs) as a child process and
// drives every route over actual HTTP. Proves: the public plane header is on
// every response, assemble output is unsigned and byte-exact against the
// canonical signing scheme, a deliberately secret-laden store can never leak
// (fail-closed 500 secret-leak-blocked), and active listings exclude
// expired/revoked grants.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SIGNING_SCHEME } from "../src/public-api/connect-agent.mjs";
import {
  normalizeGrant,
  canonicalizeGrant,
  grantId,
  GRANT_VERSION,
} from "../src/public-control/policy-schema.mjs";
import { resolvePublicBind } from "../src/public-api/http.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18799;
const BASE = `http://127.0.0.1:${PORT}`;

const NOW = Math.floor(Date.now() / 1000); // fixed for this test process

const AGENT = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";
const TARGET = "0x3333333333333333333333333333333333333333";

// Deliberately secret-shaped value (raw 32-byte hex key). Must NEVER appear
// in any HTTP response body.
const RAW_KEY = `0x${"ab".repeat(32)}`;

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("resolvePublicBind refuses non-loopback hosts", () => {
  assert.deepEqual(resolvePublicBind({ host: "127.0.0.1", port: 8799 }), { host: "127.0.0.1", port: 8799 });
  assert.throws(() => resolvePublicBind({ host: "0.0.0.0", port: 8799 }), /loopback/i);
  assert.throws(() => resolvePublicBind({ host: "192.168.1.5", port: 8799 }), /loopback/i);
});

test("resolvePublicBind refuses non-loopback hosts from env", () => {
  withEnv({ ORACLE_PUBLIC_HOST: "0.0.0.0", MAD_PUBLIC_HOST: null }, () => {
    assert.throws(() => resolvePublicBind(), /loopback/i);
  });
});

function baseInput(overrides = {}) {
  return {
    chainId: 8453,
    agentAddress: AGENT,
    accountAddress: ACCOUNT,
    actions: ["swap:exec", "read:balance"],
    targets: [TARGET],
    maxValueWei: "1000000000000000000",
    maxGasWei: "50000000000000000",
    maxSlippageBps: 50,
    expiresAt: NOW + 3600,
    nonce: "n-1",
    revocationKey: "revoke.n-1",
    ...overrides,
  };
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* leave json null */
  }
  return { status: res.status, headers: res.headers, text, json };
}

let child;

before(async () => {
  child = spawn(process.execPath, ["bin/oracle-public-server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      ORACLE_PUBLIC_HOST: "127.0.0.1",
      ORACLE_PUBLIC_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let booted = false;
  let bootLog = "";
  child.stdout.on("data", (d) => {
    bootLog += String(d);
    if (bootLog.includes("listening")) booted = true;
  });
  child.stderr.on("data", (d) => {
    bootLog += String(d);
  });
  for (let i = 0; i < 100 && !booted; i++) await sleep(50);
  assert.equal(booted, true, `server did not boot: ${bootLog}`);
  // Boot log must never carry secret-shaped material either.
  assert.ok(!bootLog.includes(RAW_KEY));
});

after(async () => {
  child?.kill("SIGTERM");
  await sleep(150);
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test("GET /public/health returns ok + plane + version with public-plane header", async () => {
  const res = await fetch(`${BASE}/public/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-oracle-plane"), "public");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.plane, "public");
  assert.match(String(body.version), /^\d+\.\d+\.\d+/);
});

test("GET / serves Oracle console index with public-plane headers", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-oracle-plane"), "public");
  assert.equal(res.headers.get("x-oracle-unsigned"), "true");
  assert.match(String(res.headers.get("content-type") || ""), /text\/html/);
  const text = await res.text();
  assert.ok(text.includes("Preview agent permissions"));
  assert.ok(text.includes("app.js"));
  assert.ok(text.includes("styles.css"));
});

test("GET /app.js and /styles.css serve console assets", async () => {
  const js = await fetch(`${BASE}/app.js`);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get("x-oracle-plane"), "public");
  assert.match(String(js.headers.get("content-type") || ""), /javascript/);
  const jsText = await js.text();
  assert.ok(jsText.includes("/public/connect/assemble"));
  assert.ok(jsText.includes("window.ethereum"));

  const css = await fetch(`${BASE}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(String(css.headers.get("content-type") || ""), /text\/css/);
  const cssText = await css.text();
  assert.ok(cssText.includes("#0A0E0D"));
});

test("GET /exec/status stays absent on public plane", async () => {
  const res = await fetch(`${BASE}/exec/status`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "not-found");
});

// ---------------------------------------------------------------------------
// connect/request
// ---------------------------------------------------------------------------

test("POST /public/connect/request builds a normalized connect request", async () => {
  const { status, headers, json } = await post("/public/connect/request", {
    input: baseInput(),
    opts: { now: NOW },
  });
  assert.equal(status, 200);
  assert.equal(headers.get("x-oracle-plane"), "public");
  assert.equal(json.kind, "oracle-connect-request");
  assert.equal(json.version, GRANT_VERSION);
  assert.equal(json.grant.agentAddress, AGENT);
  assert.deepEqual(json.grant.actions, ["read:balance", "swap:exec"]); // sorted
  assert.ok(!("signature" in json) && !("signature" in json.grant));
});

test("POST /public/connect/request also accepts raw grant fields as the body", async () => {
  const { status, json } = await post("/public/connect/request", {
    ...baseInput(),
    opts: { now: NOW },
  });
  assert.equal(status, 200);
  assert.equal(json.kind, "oracle-connect-request");
  assert.equal(json.grant.accountAddress, ACCOUNT);
});

test("POST /public/connect/request pins TTL validation to server time", async () => {
  const serverNow = Math.floor(Date.now() / 1000);
  const { status, json } = await post("/public/connect/request", {
    input: baseInput({ expiresAt: serverNow + 86_401 }),
    opts: { now: serverNow + 86_400 },
  });
  assert.equal(status, 400);
  assert.equal(json.error, "invalid-grant");
  assert.match(JSON.stringify(json.errors), /24-hour TTL/);

  const wildcard = await post("/public/connect/request", {
    input: baseInput({ actions: ["swap:*"] }),
    opts: { allowWildcardActions: true },
  });
  assert.equal(wildcard.status, 400);
  assert.equal(wildcard.json.error, "invalid-grant");
  assert.match(JSON.stringify(wildcard.json.errors), /wildcard action.*rejected/);
});

test("POST /public/connect/request rejects invalid grants with 400 invalid-grant", async () => {
  const { status, headers, json } = await post("/public/connect/request", {
    input: { ...baseInput(), chainId: -5 },
    opts: { now: NOW },
  });
  assert.equal(status, 400);
  assert.equal(headers.get("x-oracle-plane"), "public");
  assert.equal(json.error, "invalid-grant");
  assert.ok(Array.isArray(json.errors) && json.errors.length > 0);
});

// ---------------------------------------------------------------------------
// connect/assemble — unsigned bytes must match SIGNING_SCHEME exactly
// ---------------------------------------------------------------------------

test("POST /public/connect/assemble returns unsigned payload with byte-exact signing bytes", async () => {
  const { status, headers, json } = await post("/public/connect/assemble", {
    input: baseInput(),
    opts: { now: NOW },
  });
  assert.equal(status, 200);
  assert.equal(headers.get("x-oracle-plane"), "public");

  assert.equal(json.kind, "oracle-unsigned-grant");
  assert.equal(json.unsigned, true);
  assert.equal(json.signing.scheme, SIGNING_SCHEME);

  // Independently recompute the canonical bytes the scheme promises.
  const expectedGrant = normalizeGrant(baseInput(), { now: NOW });
  const expectedCanonical = canonicalizeGrant(expectedGrant);
  const expectedBytes = Buffer.from(expectedCanonical, "utf8");
  const expectedId = grantId(expectedGrant);

  assert.equal(json.payload.grantId, expectedId);
  assert.equal(json.payload.canonical, expectedCanonical);
  assert.equal(json.signing.message, expectedCanonical);
  assert.equal(json.signing.bytesHex, `0x${expectedBytes.toString("hex")}`);
  assert.equal(json.signing.byteLength, expectedBytes.length);
  assert.equal(json.signing.sha256, expectedId);

  // Unsigned means unsigned: no signature material anywhere in the response.
  assert.ok(!JSON.stringify(json).includes('"signature"'));
  assert.match(json.render, /UNSIGNED/);
});

test("POST /public/connect/assemble accepts a connect-request wrapper and is deterministic", async () => {
  const req = await post("/public/connect/request", { input: baseInput(), opts: { now: NOW } });
  const a = await post("/public/connect/assemble", { request: req.json, opts: { now: NOW } });
  const b = await post("/public/connect/assemble", { input: baseInput(), opts: { now: NOW } });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.json.signing.bytesHex, b.json.signing.bytesHex);
  assert.equal(a.json.payload.grantId, b.json.payload.grantId);
});

// ---------------------------------------------------------------------------
// grants/active + grants/get — expiry/revocation semantics over HTTP
// ---------------------------------------------------------------------------

test("POST /public/grants/active excludes expired and revoked grants", async () => {
  const active = baseInput({ nonce: "n-active", revocationKey: "rk.active" });
  const expired = baseInput({ nonce: "n-expired", revocationKey: "rk.expired", expiresAt: NOW - 10 });
  const revokedByFlag = baseInput({ nonce: "n-revflag", revocationKey: "rk.revflag" });
  const revokedByOpts = baseInput({ nonce: "n-revopts", revocationKey: "rk.revopts" });

  const store = [active, expired, { grant: revokedByFlag, revoked: true }, revokedByOpts];
  const { status, headers, json } = await post("/public/grants/active", {
    store,
    opts: { now: NOW, revoked: ["rk.revopts"] },
  });
  assert.equal(status, 200);
  assert.equal(headers.get("x-oracle-plane"), "public");
  assert.equal(json.ok, true);
  assert.equal(json.count, 1);
  assert.equal(json.grants.length, 1);

  const expectedActiveId = grantId(normalizeGrant(active, { now: NOW }));
  assert.equal(json.grants[0].id, expectedActiveId);
  assert.equal(json.grants[0].grant.nonce, "n-active");
});

test("POST /public/grants/active cannot revive an expired grant with caller time", async () => {
  const serverNow = Math.floor(Date.now() / 1000);
  const expired = baseInput({ expiresAt: serverNow - 1, nonce: "n-clock", revocationKey: "rk.clock" });
  const { status, json } = await post("/public/grants/active", {
    store: [expired],
    opts: { now: serverNow - 3600 },
  });
  assert.equal(status, 200);
  assert.equal(json.count, 0);
});

test("POST /public/grants/active supports agent/account/chain filters", async () => {
  const mine = baseInput({ nonce: "n-mine", revocationKey: "rk.mine" });
  const other = baseInput({
    nonce: "n-other",
    revocationKey: "rk.other",
    agentAddress: "0x4444444444444444444444444444444444444444",
  });
  const { status, json } = await post("/public/grants/active", {
    store: [mine, other],
    opts: { now: NOW, agentAddress: AGENT },
  });
  assert.equal(status, 200);
  assert.equal(json.count, 1);
  assert.equal(json.grants[0].grant.nonce, "n-mine");
});

test("POST /public/grants/get surfaces status for expired grants and 404s unknown ids", async () => {
  const expired = baseInput({ nonce: "n-exp2", revocationKey: "rk.exp2", expiresAt: NOW - 10 });
  const id = grantId(normalizeGrant(expired));
  const hit = await post("/public/grants/get", { store: [expired], id, opts: { now: NOW } });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("x-oracle-plane"), "public");
  assert.equal(hit.json.status, "expired");
  assert.equal(hit.json.id, id);

  const miss = await post("/public/grants/get", {
    store: [expired],
    id: "f".repeat(64),
    opts: { now: NOW },
  });
  assert.equal(miss.status, 404);
  assert.equal(miss.json.error, "grant-not-found");
});

// ---------------------------------------------------------------------------
// HARD invariant: secret-laden store can never leak over HTTP
// ---------------------------------------------------------------------------

test("secret-laden store is blocked fail-closed: 500 secret-leak-blocked, no secret bytes in response", async () => {
  // nonce carrying a raw 32-byte hex key passes shape validation but MUST be
  // caught by the no-secret scan before any response body is sent.
  const poisoned = baseInput({ nonce: RAW_KEY, revocationKey: "rk.poisoned" });
  const clean = baseInput({ nonce: "n-clean", revocationKey: "rk.clean" });

  const { status, headers, text, json } = await post("/public/grants/active", {
    store: [clean, poisoned],
    opts: { now: NOW },
  });
  assert.equal(status, 500);
  assert.equal(headers.get("x-oracle-plane"), "public");
  assert.deepEqual(json, { error: "secret-leak-blocked" });
  assert.ok(!text.includes(RAW_KEY), "raw key bytes must never reach the wire");
});

test("secret-shaped fields on store records are excluded, never echoed", async () => {
  // Wrapper record smuggling secret material NEXT TO a valid grant: the
  // public read path only ever returns the normalized grant, so the secret
  // must not appear anywhere in the response.
  const clean = baseInput({ nonce: "n-clean2", revocationKey: "rk.clean2" });
  const { status, text, json } = await post("/public/grants/active", {
    store: [{ grant: clean, ownerNote: RAW_KEY }],
    opts: { now: NOW },
  });
  assert.equal(status, 200); // only the normalized grant is returned
  assert.equal(json.count, 1);
  assert.equal(json.grants[0].grant.nonce, "n-clean2");
  assert.ok(!text.includes(RAW_KEY), "wrapper secret must never be echoed");
});

test("assemble with secret-shaped input is blocked, not echoed", async () => {
  const { status, text, json } = await post("/public/connect/assemble", {
    input: baseInput({ nonce: RAW_KEY }),
    opts: { now: NOW },
  });
  assert.equal(status, 500);
  assert.deepEqual(json, { error: "secret-leak-blocked" });
  assert.ok(!text.includes(RAW_KEY));
});

// ---------------------------------------------------------------------------
// transport hygiene
// ---------------------------------------------------------------------------

test("unknown routes 404 and wrong methods 405, both still on the public plane", async () => {
  const missing = await fetch(`${BASE}/public/nope`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-oracle-plane"), "public");

  const wrongMethod = await fetch(`${BASE}/public/health`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("x-oracle-plane"), "public");
});

test("malformed JSON body is a 400 invalid-json", async () => {
  const res = await fetch(`${BASE}/public/connect/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid-json");
});
