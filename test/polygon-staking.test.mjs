// Polygon PoS staking provider (mocked — no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { dataCatalog, dataCall } from "../src/data/desk-data.mjs";
import { normalizeValidator, validatorId } from "../src/data/providers/polygon-staking.mjs";

function validator(id, over = {}) {
  return {
    id,
    name: ` V${id} `,
    status: "active",
    currentState: "HEALTHY",
    owner: "0xaa",
    signer: "0xbb",
    contractAddress: "0xcc",
    commissionPercent: 5,
    uptimePercent: 100,
    performanceIndex: 100,
    delegationEnabled: true,
    activationEpoch: 1,
    deactivationEpoch: 0,
    jailEndEpoch: 0,
    missedLatestCheckpointcount: 0,
    selfStake: 1e22,
    delegatedStake: 2e23,
    totalStaked: id * 1e22,
    signerPublicKey: "0xdeadbeef",
    ...over,
  };
}

function listFetch(rows, seen = []) {
  return async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({ success: true, result: rows, summary: { total: rows.length }, status: "success" }),
    };
  };
}

const opts = () => ({ dedupe: false });

test("catalog registers polygon-staking with its three ops", () => {
  const meta = dataCatalog().find((p) => p.id === "polygon-staking");
  assert.ok(meta, "polygon-staking missing from catalog");
  assert.equal(meta.venue, "polygon-staking");
  assert.deepEqual(meta.chainIds, [137]);
  assert.equal(meta.auth, "none");
  assert.equal(meta.execution, "read-only");
  assert.deepEqual(meta.ops, ["health", "validators", "validatorDetail"]);
});

test("validators paginates CLIENT-side because upstream ignores limit", async () => {
  // The real API returns the full set no matter what limit is sent. The provider
  // must not forward limit/offset (that would make limit:3 return everything),
  // and must slice locally instead.
  const rows = [9, 10, 12, 16, 18].map((id) => validator(id));
  const seen = [];
  const fetchImpl = listFetch(rows, seen);

  const page1 = await dataCall("polygon-staking", "validators", { limit: 2 }, { ...opts(), fetchImpl });
  assert.equal(page1.count, 2);
  assert.equal(page1.total, 5, "total must be the upstream count, not the page size");
  assert.deepEqual(page1.validators.map((v) => v.id), [9, 10]);
  assert.ok(!/limit=/.test(seen[0]), `must not forward an ignored limit param: ${seen[0]}`);

  const page2 = await dataCall("polygon-staking", "validators", { limit: 2, offset: 2 }, { ...opts(), fetchImpl });
  assert.deepEqual(page2.validators.map((v) => v.id), [12, 16]);

  const past = await dataCall("polygon-staking", "validators", { limit: 2, offset: 99 }, { ...opts(), fetchImpl });
  assert.equal(past.count, 0);
});

test("validators filters and sorts", async () => {
  const rows = [
    validator(1, { totalStaked: 5e22, currentState: "HEALTHY", delegationEnabled: true }),
    validator(2, { totalStaked: 9e22, currentState: "GRACE_PERIOD_1", delegationEnabled: false }),
    validator(3, { totalStaked: 1e22, currentState: "HEALTHY", delegationEnabled: true }),
  ];
  const fetchImpl = listFetch(rows);

  const grace = await dataCall(
    "polygon-staking",
    "validators",
    { currentState: "grace_period_1" },
    { ...opts(), fetchImpl }
  );
  assert.deepEqual(grace.validators.map((v) => v.id), [2]);
  assert.equal(grace.matched, 1);
  assert.equal(grace.total, 3, "total stays the unfiltered upstream count");

  const off = await dataCall("polygon-staking", "validators", { delegationEnabled: false }, { ...opts(), fetchImpl });
  assert.deepEqual(off.validators.map((v) => v.id), [2]);

  const top = await dataCall(
    "polygon-staking",
    "validators",
    { sortBy: "totalStaked", direction: "DESC" },
    { ...opts(), fetchImpl }
  );
  assert.deepEqual(top.validators.map((v) => v.id), [2, 1, 3]);

  // An unknown sort key falls back to id rather than producing arbitrary order.
  const bogus = await dataCall("polygon-staking", "validators", { sortBy: "__proto__" }, { ...opts(), fetchImpl });
  assert.equal(bogus.sortBy, "id");
  assert.deepEqual(bogus.validators.map((v) => v.id), [1, 2, 3]);
});

test("limit is clamped and raw passes the upstream record through", async () => {
  const fetchImpl = listFetch([validator(1)]);
  const clamped = await dataCall("polygon-staking", "validators", { limit: 99999 }, { ...opts(), fetchImpl });
  assert.equal(clamped.limit, 200);

  const norm = await dataCall("polygon-staking", "validators", {}, { ...opts(), fetchImpl });
  assert.equal(norm.validators[0].signerPublicKey, undefined);
  assert.equal(norm.validators[0].name, "V1", "name is trimmed");

  const raw = await dataCall("polygon-staking", "validators", { raw: true }, { ...opts(), fetchImpl });
  assert.equal(raw.validators[0].signerPublicKey, "0xdeadbeef");
});

test("stake is reported as approximate, never as false precision", () => {
  // Upstream serves wei-scale as float64, so the low digits are already lost.
  const v = normalizeValidator(validator(1, { totalStaked: 2.50090722768676e24 }));
  assert.equal(v.totalStakedRaw, 2.50090722768676e24, "raw value passes through untouched");
  assert.ok(Math.abs(v.totalStakedPolApprox - 2500907.22768676) < 1e-6);
  assert.match(v.stakePrecision, /approximate/);
  assert.equal(typeof v.totalStakedPolApprox, "number");
});

test("validatorDetail validates the id before making a request", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, headers: { get: () => null }, text: async () => "{}" };
  };
  for (const bad of [{}, { id: "abc" }, { id: -1 }, { id: "1; DROP" }, { id: 1.5 }]) {
    await assert.rejects(
      () => dataCall("polygon-staking", "validatorDetail", bad, { ...opts(), fetchImpl }),
      /positive integer validator id/
    );
  }
  assert.equal(called, false, "a malformed id must never reach the network");
  assert.equal(validatorId("42"), 42);
});

test("validatorDetail returns the enriched record", async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/validators\/9$/);
    return {
      ok: true,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          success: true,
          result: validator(9, { delegatorCount: 119, checkpointsSigned: 700, isInAuction: false }),
          status: "success",
        }),
    };
  };
  const d = await dataCall("polygon-staking", "validatorDetail", { validatorId: "9" }, { ...opts(), fetchImpl });
  assert.equal(d.id, 9);
  assert.equal(d.chainId, 137);
  assert.equal(d.validator.delegatorCount, 119);
  assert.equal(d.validator.checkpointsSigned, 700);
});

test("a 200 response carrying success:false is treated as a failure", async () => {
  // The upstream envelope reports errors with HTTP 200, so httpJson cannot see
  // them — the provider has to check the envelope itself.
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({ success: false, message: "reverted", status: "error" }),
  });
  await assert.rejects(
    () => dataCall("polygon-staking", "validators", {}, { ...opts(), fetchImpl }),
    /reverted/
  );
  const h = await dataCall("polygon-staking", "health", {}, { ...opts(), fetchImpl });
  assert.equal(h.ok, false, "health reports down rather than throwing");
  assert.equal(h.exec, false);
});

test("health reports ok with the validator total", async () => {
  const fetchImpl = listFetch([validator(1), validator(2)]);
  const h = await dataCall("polygon-staking", "health", {}, { ...opts(), fetchImpl });
  assert.equal(h.ok, true);
  assert.equal(h.validatorTotal, 2);
  assert.equal(h.chainId, 137);
  assert.equal(h.exec, false);
});

test("the read plane refuses ops polygon-staking does not declare", async () => {
  await assert.rejects(
    () => dataCall("polygon-staking", "delegate", { amount: "1" }, opts()),
    /does not support op/
  );
});
