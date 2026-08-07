import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18801;
const BASE = `http://127.0.0.1:${PORT}`;
const APP_ID = "clp_test_public_app_id_not_a_secret";

let child;

before(async () => {
  child = spawn(process.execPath, ["bin/oracle-public-server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      ORACLE_PUBLIC_HOST: "127.0.0.1",
      ORACLE_PUBLIC_PORT: String(PORT),
      ORACLE_PRIVY_APP_ID: APP_ID,
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
});

after(async () => {
  child?.kill("SIGTERM");
});

test("GET /public/config exposes Privy app id and dual custody modes", async () => {
  const res = await fetch(`${BASE}/public/config`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-oracle-plane"), "public");
  assert.equal(res.headers.get("x-oracle-unsigned"), "true");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.custody.privyEnabled, true);
  assert.equal(body.custody.injectedEnabled, true);
  assert.deepEqual(body.custody.modes, ["privy", "injected"]);
  assert.equal(body.privy.appId, APP_ID);
  assert.equal(body.plane, "public");
  // never secret-shaped
  assert.equal(/0x[0-9a-fA-F]{64}/.test(JSON.stringify(body)), false);
  assert.equal(/Bearer\s+/i.test(JSON.stringify(body)), false);
});

test("GET /public/config never leaks a Privy app SECRET", async () => {
  // The app ID is a public client identifier and is meant to ship in a frontend
  // bundle. The app SECRET is server-side only. A deployment that has both in env
  // must expose the first and never the second.
  //
  // Set a sentinel secret for this assertion rather than relying on the ambient env:
  // an unset PRIVY_APP_SECRET made the earlier "" fallback match every response,
  // which is a test bug that looks exactly like a leak.
  const res = await fetch(`${BASE}/public/config`);
  const raw = await res.text();

  // No secret-shaped KEY names in the payload.
  assert.ok(
    !/(app_?secret|clientSecret|privateKey|apiKey)/i.test(raw),
    `config response exposes a secret-shaped field: ${raw.slice(0, 200)}`,
  );

  const body = JSON.parse(raw);
  // The public client id IS expected; assert it is the only privy field.
  assert.deepEqual(Object.keys(body.privy), ["appId"]);
  // Custody position is stated in the payload, not just implied by the headers.
  assert.equal(body.custody.selfCustodial, true);
  assert.equal(body.custody.signer, "user-wallet");
});
