import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAudit,
  verifyChain,
  getEntries,
  computeHash,
  canonicalJson,
  GENESIS_HASH,
  AUDIT_ACTIONS,
} from "../src/audit-log.mjs";

function tmpLog() {
  return join(mkdtempSync(join(tmpdir(), "mad-audit-")), "audit.jsonl");
}

test("canonicalJson sorts object keys recursively and is order-independent", () => {
  const a = canonicalJson({ z: 1, a: 2, m: { y: 1, b: 2 } });
  const b = canonicalJson({ a: 2, m: { b: 2, y: 1 }, z: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"m":{"b":2,"y":1},"z":1}');
});

test("first entry starts at seq 1 with null prevHash", async () => {
  const path = tmpLog();
  const e = await appendAudit({ action: AUDIT_ACTIONS.SIGN, actor: "0xabc", detail: { x: 1 }, path });
  assert.equal(e.seq, 1);
  assert.equal(e.prevHash, null);
  assert.equal(e.hash.length, 64);
});

test("entries chain: each prevHash equals prior hash", async () => {
  const path = tmpLog();
  const e1 = await appendAudit({ action: AUDIT_ACTIONS.PREPARE, path });
  const e2 = await appendAudit({ action: AUDIT_ACTIONS.SIGN, path });
  const e3 = await appendAudit({ action: AUDIT_ACTIONS.BROADCAST, path });
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e3.seq, 3);
  assert.equal(e2.prevHash, e1.hash);
  assert.equal(e3.prevHash, e2.hash);
  const v = verifyChain({ path });
  assert.equal(v.ok, true);
  assert.equal(v.count, 3);
});

test("streams are independent chains in the same file", async () => {
  const path = tmpLog();
  const a1 = await appendAudit({ action: AUDIT_ACTIONS.SIGN, stream: "chA", path });
  const b1 = await appendAudit({ action: AUDIT_ACTIONS.SIGN, stream: "chB", path });
  const a2 = await appendAudit({ action: AUDIT_ACTIONS.SIGN, stream: "chA", path });
  assert.equal(a1.seq, 1);
  assert.equal(b1.seq, 1);
  assert.equal(a2.seq, 2);
  assert.equal(a2.prevHash, a1.hash);
  assert.notEqual(a2.prevHash, b1.hash);
  assert.equal(verifyChain({ stream: "chA", path }).ok, true);
  assert.equal(verifyChain({ stream: "chB", path }).ok, true);
});

test("verify detects a tampered detail field", async () => {
  const path = tmpLog();
  await appendAudit({ action: AUDIT_ACTIONS.SIGN, detail: { to: "0x1" }, path });
  await appendAudit({ action: AUDIT_ACTIONS.SIGN, detail: { to: "0x2" }, path });
  await appendAudit({ action: AUDIT_ACTIONS.SIGN, detail: { to: "0x3" }, path });
  // Tamper: rewrite line 2's detail without recomputing the hash.
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const row = JSON.parse(lines[1]);
  row.detail = { to: "0xDEADBEEF" };
  lines[1] = JSON.stringify(row);
  writeFileSync(path, lines.join("\n") + "\n");
  const v = verifyChain({ path });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "hash-mismatch");
  assert.equal(v.seq, 2);
});

test("verify detects a deleted entry (seq gap breaks chain)", async () => {
  const path = tmpLog();
  await appendAudit({ action: AUDIT_ACTIONS.SIGN, path });
  await appendAudit({ action: AUDIT_ACTIONS.SIGN, path });
  await appendAudit({ action: AUDIT_ACTIONS.SIGN, path });
  const lines = readFileSync(path, "utf8").trim().split("\n");
  // Drop the middle entry.
  writeFileSync(path, [lines[0], lines[2]].join("\n") + "\n");
  const v = verifyChain({ path });
  assert.equal(v.ok, false);
  // seq jumps 1 -> 3: caught as a seq gap.
  assert.equal(v.reason, "seq-gap");
});

test("verify detects a reordered entry", async () => {
  const path = tmpLog();
  await appendAudit({ action: AUDIT_ACTIONS.SIGN, detail: { n: 1 }, path });
  await appendAudit({ action: AUDIT_ACTIONS.SIGN, detail: { n: 2 }, path });
  const lines = readFileSync(path, "utf8").trim().split("\n");
  writeFileSync(path, [lines[1], lines[0]].join("\n") + "\n");
  const v = verifyChain({ path });
  assert.equal(v.ok, false);
});

test("empty chain verifies false with reason empty", () => {
  const path = tmpLog();
  const v = verifyChain({ path });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "empty");
});

test("null actor differs from empty-string actor (presence tag)", () => {
  const base = { stream: "s", seq: 1, ts: "2026-01-01T00:00:00Z", action: "a", objectId: null, detail: null, prevHash: null };
  const nul = computeHash({ ...base, actor: null });
  const empty = computeHash({ ...base, actor: "" });
  assert.notEqual(nul, empty);
});

test("genesis hash is 32 zero bytes hex", () => {
  assert.equal(GENESIS_HASH, "0".repeat(64));
});

test("getEntries returns entries from a seq for a stream", async () => {
  const path = tmpLog();
  for (let i = 0; i < 5; i++) await appendAudit({ action: AUDIT_ACTIONS.SIGN, path });
  const rows = getEntries({ fromSeq: 3, path });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].seq, 3);
});
