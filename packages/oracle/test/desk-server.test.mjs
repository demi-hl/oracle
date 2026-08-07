// Desk HTTP server smoke (in-process, no network providers needed for /health + /catalog).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18787;

test("D4 desk-server /health and /data/catalog", async () => {
  const child = spawn(process.execPath, ["bin/desk-server.mjs"], {
    cwd: root,
    env: { ...process.env, MAD_DESK_PORT: String(PORT), MAD_DESK_HOST: "127.0.0.1", ORACLE_ONBOARD_HTTP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let booted = false;
  child.stdout.on("data", (d) => {
    if (String(d).includes("listening")) booted = true;
  });
  try {
    for (let i = 0; i < 40 && !booted; i++) await sleep(50);
    assert.equal(booted, true, "server did not boot");

    const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.match(health.plane, /data/);
    assert.equal(health.exec, false);

    const cat = await fetch(`http://127.0.0.1:${PORT}/data/catalog`).then((r) => r.json());
    assert.ok(cat.catalog.some((p) => p.id === "hl-info"));
    assert.ok(cat.catalog.some((p) => p.id === "evm-rpc"));

    const tiers = await fetch(`http://127.0.0.1:${PORT}/onboard/tiers`).then((r) => r.json());
    assert.ok(tiers.tiers.some((t) => t.id === "observer"));

    // sign-like op blocked
    const blocked = await fetch(
      `http://127.0.0.1:${PORT}/data/call?provider=hl-info&op=placeOrder`
    ).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(blocked.status, 403);
  } finally {
    child.kill("SIGTERM");
    await sleep(100);
  }
});

test("public data mode blocks apiKey-backed provider calls unless explicitly allowed", async () => {
  const port = PORT + 1;
  const child = spawn(process.execPath, ["bin/desk-server.mjs"], {
    cwd: root,
    env: { ...process.env, MAD_DESK_PORT: String(port), MAD_DESK_HOST: "127.0.0.1", MAD_PUBLIC_API_MODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let booted = false;
  child.stdout.on("data", (d) => {
    if (String(d).includes("listening")) booted = true;
  });
  try {
    for (let i = 0; i < 40 && !booted; i++) await sleep(50);
    assert.equal(booted, true, "server did not boot");

    const blocked = await fetch(`http://127.0.0.1:${port}/data/call?provider=oneinch&op=prepare&args={}`)
      .then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /public mode.*server API key/i);

    const keyless = await fetch(`http://127.0.0.1:${port}/data/call?provider=evm-rpc&op=chainId&args={"chainId":8453}`)
      .then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(keyless.status, 200);
    assert.equal(keyless.body.provider, "evm-rpc");
  } finally {
    child.kill("SIGTERM");
    await sleep(100);
  }
});
