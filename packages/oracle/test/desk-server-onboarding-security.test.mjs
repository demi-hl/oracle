// Desk server onboarding must fail closed for public/self-hosted release.
// Mint/list/revoke of API keys requires explicit enablement plus wallet proof;
// loopback binding alone is not an auth boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_PORT = 18817;

async function bootDesk(env) {
  const child = spawn(process.execPath, ["bin/desk-server.mjs"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let booted = false;
  let log = "";
  child.stdout.on("data", (d) => {
    log += String(d);
    if (log.includes("listening")) booted = true;
  });
  child.stderr.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 80 && !booted; i++) await sleep(50);
  assert.equal(booted, true, `server did not boot: ${log}`);
  return child;
}

async function json(res) {
  return { status: res.status, body: await res.json() };
}

async function proofFor(port, wallet, { action, tier, id } = {}) {
  const challenge = await json(await fetch(`http://127.0.0.1:${port}/onboard/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: wallet.address, action, tier, id }),
  }));
  assert.equal(challenge.status, 200);
  const signature = await wallet.signMessage(challenge.body.message);
  return { message: challenge.body.message, signature };
}

test("onboarding HTTP is disabled by default", async () => {
  const port = BASE_PORT;
  const child = await bootDesk({ ORACLE_DATA_PORT: String(port), ORACLE_DATA_HOST: "127.0.0.1", ORACLE_ONBOARD_HTTP: "", MAD_ONBOARD_HTTP: "" });
  try {
    const health = await json(await fetch(`http://127.0.0.1:${port}/health`));
    assert.equal(health.body.onboardHttp, false);
    const tiers = await json(await fetch(`http://127.0.0.1:${port}/onboard/tiers`));
    assert.equal(tiers.status, 403);
  } finally {
    child.kill("SIGTERM");
    await sleep(100);
  }
});

test("onboarding HTTP only enables on literal 1", async () => {
  for (const [i, value] of ["true", "yes", "on", "banana"].entries()) {
    const port = BASE_PORT + 20 + i;
    const child = await bootDesk({
      ORACLE_DATA_PORT: String(port),
      ORACLE_DATA_HOST: "127.0.0.1",
      ORACLE_ONBOARD_HTTP: value,
      MAD_ONBOARD_HTTP: "",
    });
    try {
      const health = await json(await fetch(`http://127.0.0.1:${port}/health`));
      assert.equal(health.body.onboardHttp, false, `ORACLE_ONBOARD_HTTP=${value} must not enable onboarding`);
      const tiers = await json(await fetch(`http://127.0.0.1:${port}/onboard/tiers`));
      assert.equal(tiers.status, 403);
    } finally {
      child.kill("SIGTERM");
      await sleep(100);
    }
  }
});

test("enabled onboarding refuses claimed owner without wallet proof and ignores scope escalation", async () => {
  const port = BASE_PORT + 1;
  const wallet = Wallet.createRandom();
  const storePath = join(tmpdir(), `oracle-onboard-test-${process.pid}-${Date.now()}.json`);
  const child = await bootDesk({
    ORACLE_DATA_PORT: String(port),
    ORACLE_DATA_HOST: "127.0.0.1",
    ORACLE_ONBOARD_HTTP: "1",
    ORACLE_AGENT_KEYS_PATH: storePath,
  });
  try {
    const noProof = await json(await fetch(`http://127.0.0.1:${port}/onboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: wallet.address, tier: "observer" }),
    }));
    assert.equal(noProof.status, 401);

    const wrongTierProof = await proofFor(port, wallet, { action: "onboard", tier: "observer" });
    const missingTier = await json(await fetch(`http://127.0.0.1:${port}/onboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: wallet.address,
        tier: "preparer",
        proof: wrongTierProof,
      }),
    }));
    assert.equal(missingTier.status, 401);
    assert.equal(missingTier.body.error, "tier-proof-mismatch");

    const proof = await proofFor(port, wallet, { action: "onboard", tier: "observer" });
    const ok = await json(await fetch(`http://127.0.0.1:${port}/onboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: wallet.address,
        tier: "observer",
        scopes: ["agent:execute"],
        proof,
      }),
    }));
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.record.scopes, ["read:markets", "read:nfts", "read:positions"]);

    const replay = await json(await fetch(`http://127.0.0.1:${port}/onboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: wallet.address, tier: "observer", proof }),
    }));
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error, "proof-replayed");

    const secondProof = await proofFor(port, wallet, { action: "onboard", tier: "observer" });
    const second = await json(await fetch(`http://127.0.0.1:${port}/onboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: wallet.address, tier: "observer", proof: secondProof }),
    }));
    assert.equal(second.status, 201);

    const revokeProof = await proofFor(port, wallet, {
      action: "revoke",
      id: ok.body.record.id,
    });
    const wrongId = await json(await fetch(`http://127.0.0.1:${port}/onboard/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: wallet.address, id: second.body.record.id, proof: revokeProof }),
    }));
    assert.equal(wrongId.status, 401);
    assert.equal(wrongId.body.error, "id-proof-mismatch");
  } finally {
    child.kill("SIGTERM");
    await sleep(100);
  }
});

test("auth failures are 4xx, not 500", async () => {
  // A rejected credential is a client error. Returning 500 told callers the
  // desk had broken and buried genuine server faults in auth noise.
  const port = BASE_PORT + 40;
  const child = await bootDesk({ ORACLE_DATA_PORT: String(port), ORACLE_DATA_HOST: "127.0.0.1", ORACLE_ONBOARD_HTTP: "1" });
  try {
    const post = (body) => fetch(`http://127.0.0.1:${port}/onboard/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(json);

    const missing = await post({});
    assert.equal(missing.status, 400, "absent key must be 400");
    assert.equal(missing.body.error, "key-required");

    const garbage = await post({ key: "mad_not-a-real-key" });
    assert.equal(garbage.status, 401, "unknown key must be 401");
    assert.equal(garbage.body.error, "invalid-key");

    // Malformed and unknown must be indistinguishable to the caller.
    const malformed = await post({ key: "" });
    assert.ok(malformed.status === 400 || malformed.status === 401);
    assert.ok(malformed.status < 500, "no auth path may return 5xx");
  } finally {
    child.kill("SIGTERM");
    await sleep(100);
  }
});
