import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openShadowStore } from "../src/strategy/shadow-store.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-shadow-store-"));
}

function storePath(dir, name = "shadow.json") {
  return path.join(dir, name);
}

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

function sampleRunner(id = "r1") {
  return {
    id,
    strategy: { id: "s" },
    strategyHash: "abc",
    compilerHash: "def",
    evidenceId: null,
    status: "running",
    cursor: null,
    intendedOrders: [],
    fills: [],
    missedFills: [],
    markouts: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

test("path is required and must be absolute", () => {
  assert.throws(() => openShadowStore({}), /absolute|path/i);
  assert.throws(() => openShadowStore({ path: null }), /absolute|path/i);
  assert.throws(() => openShadowStore({ path: "relative/shadow.json" }), /absolute|path/i);
});

test("creates parent directory and file mode 0600 with version 1 runners array", () => {
  const dir = tmpDir();
  const p = storePath(dir, "nested/dir/shadow.json");
  const store = openShadowStore({ path: p });
  assert.equal(fs.existsSync(p), true);
  assert.equal(modeOf(p), 0o600);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.runners, []);
  assert.deepEqual(store.list(), []);
});

test("create get list update stop with deep-cloned returns", () => {
  const dir = tmpDir();
  const p = storePath(dir);
  const store = openShadowStore({ path: p });
  const created = store.create(sampleRunner("r-a"));
  assert.equal(created.id, "r-a");
  created.status = "mutated";
  created.intendedOrders.push({ x: 1 });
  const got = store.get("r-a");
  assert.equal(got.status, "running");
  assert.deepEqual(got.intendedOrders, []);
  got.fills.push({ y: 2 });
  assert.deepEqual(store.get("r-a").fills, []);
  const listed = store.list();
  assert.equal(listed.length, 1);
  listed[0].status = "nope";
  assert.equal(store.get("r-a").status, "running");

  const updated = store.update("r-a", (rec) => {
    rec.cursor = 42;
    rec.intendedOrders.push({ id: "o1" });
    return rec;
  });
  assert.equal(updated.cursor, 42);
  assert.equal(store.get("r-a").intendedOrders.length, 1);

  const stopped = store.stop("r-a");
  assert.equal(stopped.status, "stopped");
  assert.equal(store.get("r-a").status, "stopped");
  const again = store.stop("r-a");
  assert.equal(again.status, "stopped");
});

test("id uniqueness is enforced", () => {
  const dir = tmpDir();
  const store = openShadowStore({ path: storePath(dir) });
  store.create(sampleRunner("dup"));
  assert.throws(() => store.create(sampleRunner("dup")), /unique|exists|duplicate/i);
});

test("get missing id returns null", () => {
  const dir = tmpDir();
  const store = openShadowStore({ path: storePath(dir) });
  assert.equal(store.get("missing"), null);
});

test("update missing id throws", () => {
  const dir = tmpDir();
  const store = openShadowStore({ path: storePath(dir) });
  assert.throws(() => store.update("missing", (r) => r), /not found|missing/i);
});

test("atomic write uses temp file mode 0600 then rename", () => {
  const dir = tmpDir();
  const p = storePath(dir);
  const store = openShadowStore({ path: p });
  store.create(sampleRunner("r1"));
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.runners.length, 1);
  assert.equal(modeOf(p), 0o600);
  // No leftover temp files after successful write.
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp") || n.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("fail closed on malformed JSON", () => {
  const dir = tmpDir();
  const p = storePath(dir);
  fs.writeFileSync(p, "{ not json", { mode: 0o600 });
  assert.throws(() => openShadowStore({ path: p }), /malformed|JSON|parse/i);
});

test("fail closed on wrong version", () => {
  const dir = tmpDir();
  const p = storePath(dir);
  fs.writeFileSync(p, JSON.stringify({ version: 99, runners: [] }), { mode: 0o600 });
  assert.throws(() => openShadowStore({ path: p }), /version/i);
});

test("fail closed on symlink store", () => {
  const dir = tmpDir();
  const real = storePath(dir, "real.json");
  const link = storePath(dir, "link.json");
  fs.writeFileSync(real, JSON.stringify({ version: 1, runners: [] }), { mode: 0o600 });
  fs.symlinkSync(real, link);
  assert.throws(() => openShadowStore({ path: link }), /symlink/i);
});

test("fail closed on non-regular file", () => {
  const dir = tmpDir();
  const p = storePath(dir, "as-dir");
  fs.mkdirSync(p);
  assert.throws(() => openShadowStore({ path: p }), /regular|not a file|directory/i);
});

test("fail closed on group or world writable existing file", () => {
  const dir = tmpDir();
  const p = storePath(dir);
  fs.writeFileSync(p, JSON.stringify({ version: 1, runners: [] }), { mode: 0o600 });
  fs.chmodSync(p, 0o660);
  assert.throws(() => openShadowStore({ path: p }), /writable|permission|mode/i);
  fs.chmodSync(p, 0o600);
  // reopen ok
  openShadowStore({ path: p });
  fs.chmodSync(p, 0o606);
  assert.throws(() => openShadowStore({ path: p }), /writable|permission|mode/i);
});

test("never stores credential key mnemonic seed signature fields at any depth", () => {
  const dir = tmpDir();
  const store = openShadowStore({ path: storePath(dir) });
  const secrets = [
    { privateKey: "x" },
    { privateKeyHex: "x" },
    { userPrivateKeyBackup: "x" },
    { apiKey: "x" },
    { authToken: "x" },
    { secretKey: "x" },
    { seed: "x" },
    { mnemonic: "x" },
    { signature: "x" },
    { credential: "x" },
    { nested: { privateKey: "deep" } },
    { intendedOrders: [{ seed: "s" }] },
  ];
  for (const bad of secrets) {
    assert.throws(
      () => store.create({ ...sampleRunner(`bad-${JSON.stringify(Object.keys(bad))}`), ...bad }),
      /secret|credential|forbidden|privateKey|mnemonic|seed|signature/i,
    );
  }
  // Ensure nothing was written with those keys.
  const disk = fs.readFileSync(storePath(dir), "utf8");
  for (const k of ["privateKey", "secretKey", "mnemonic", "\"seed\"", "signature", "credential"]) {
    assert.equal(disk.includes(k), false, `disk must not contain ${k}`);
  }
});

test("process-local serialized mutations avoid lost updates", async () => {
  const dir = tmpDir();
  const store = openShadowStore({ path: storePath(dir) });
  store.create(sampleRunner("ser"));
  let started = 0;
  let finished = 0;
  const tasks = Array.from({ length: 20 }, (_, i) =>
    Promise.resolve().then(async () => {
      started += 1;
      await store.update("ser", (rec) => {
        // Simulate interleaved work inside updater path via microtask yield after read.
        rec.intendedOrders = [...rec.intendedOrders, { i }];
        return rec;
      });
      finished += 1;
    }),
  );
  await Promise.all(tasks);
  assert.equal(started, 20);
  assert.equal(finished, 20);
  assert.equal(store.get("ser").intendedOrders.length, 20);
});

test("source and tests contain no em dash or en dash", () => {
  const src = fs.readFileSync(new URL("../src/strategy/shadow-store.mjs", import.meta.url), "utf8");
  const testSrc = fs.readFileSync(new URL(import.meta.url), "utf8");
  for (const text of [src, testSrc]) {
    assert.equal(text.includes("\u2014"), false, "em dash forbidden");
    assert.equal(text.includes("\u2013"), false, "en dash forbidden");
  }
});
