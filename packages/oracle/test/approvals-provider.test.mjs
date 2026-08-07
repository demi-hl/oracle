// Approvals provider — offline contract tests.
//
// Every RPC call is stubbed. These tests pin the properties that matter for a
// self-custody surface: liveness comes from a fresh allowance read, zero
// allowances are dropped, unbounded approvals are flagged, an empty result is
// never dressed up as safety, and nothing in this provider can sign.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { approvalsScan, approvalsHealth, clearApprovalsCache } from "../src/data/providers/approvals.mjs";

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/data/providers/approvals.mjs"),
  "utf8",
);

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Minimal JSON-RPC stub. `allowances` maps "token:spender" to a bigint; any
 * pair not listed reads as zero, which is what a revoked approval looks like
 * on chain.
 */
function stubFetch({ allowances = {}, logsFail = true, logs = [] } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const respond = (result) => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
    });

    if (body.method === "eth_blockNumber") return respond("0x1000000");
    if (body.method === "eth_getLogs") {
      if (logsFail) throw new Error("HTTP 403 POST (endpoint refuses eth_getLogs)");
      return respond(logs);
    }
    if (body.method === "eth_call") {
      const to = String(body.params?.[0]?.to || "").toLowerCase();
      const data = String(body.params?.[0]?.data || "");
      // allowance(address,address) selector
      if (data.startsWith("0xdd62ed3e")) {
        const spender = `0x${data.slice(-40)}`.toLowerCase();
        const value = allowances[`${to}:${spender}`] ?? 0n;
        return respond(`0x${value.toString(16).padStart(64, "0")}`);
      }
      // decimals() — 18, so log-discovered tokens can format an allowance.
      if (data.startsWith("0x313ce567")) {
        return respond(`0x${(18n).toString(16).padStart(64, "0")}`);
      }
      // symbol() — ABI-encoded dynamic string "TKN".
      if (data.startsWith("0x95d89b41")) {
        return respond(
          `0x${(32n).toString(16).padStart(64, "0")}${(3n).toString(16).padStart(64, "0")}${Buffer.from("TKN").toString("hex").padEnd(64, "0")}`,
        );
      }
      return respond("0x");
    }
    throw new Error(`unexpected rpc method ${body.method}`);
  };
}

test("a live unlimited allowance is reported and flagged unlimited", async () => {
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const result = await approvalsScan(
    { owner: OWNER, chainIds: [1] },
    { fetchImpl: stubFetch({ allowances: { [`${usdc}:${permit2}`]: UINT256_MAX } }) },
  );

  const hit = result.approvals.find((a) => a.token === usdc && a.spender === permit2);
  assert.ok(hit, "expected the seeded allowance to be discovered");
  assert.equal(hit.unlimited, true);
  assert.equal(hit.risk, "unlimited");
  assert.equal(hit.allowanceDisplay, "UNLIMITED");
  assert.equal(hit.spenderLabel, "Permit2");
});

test("a zero allowance is treated as revoked and never listed", async () => {
  const result = await approvalsScan(
    { owner: OWNER, chainIds: [1] },
    { fetchImpl: stubFetch({ allowances: {} }) },
  );
  assert.equal(result.approvals.length, 0);
});

test("a bounded allowance is scoped, not flagged unlimited", async () => {
  const dai = "0x6b175474e89094c44da98b954eedeac495271d0f";
  const router = "0x7a250d5630b4cf539739df2c5dacb4c659f2488d";
  const result = await approvalsScan(
    { owner: OWNER, chainIds: [1] },
    { fetchImpl: stubFetch({ allowances: { [`${dai}:${router}`]: 1000n * 10n ** 18n } }) },
  );

  const hit = result.approvals.find((a) => a.token === dai && a.spender === router);
  assert.ok(hit);
  assert.equal(hit.unlimited, false);
  assert.notEqual(hit.risk, "unlimited");
  assert.equal(hit.allowanceDisplay, "1,000");
});

test("an empty result still warns that it is not proof of safety", async () => {
  const result = await approvalsScan(
    { owner: OWNER, chainIds: [1] },
    { fetchImpl: stubFetch({ allowances: {} }) },
  );
  assert.equal(result.approvals.length, 0);
  assert.ok(
    result.warnings.some((w) => /not that the wallet is safe/i.test(w)),
    "an empty approval list must never be presented as safety",
  );
});

test("log scanning is preferred but its refusal degrades to a live probe", async () => {
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const result = await approvalsScan(
    { owner: OWNER, chainIds: [1] },
    { fetchImpl: stubFetch({ logsFail: true, allowances: { [`${usdc}:${permit2}`]: UINT256_MAX } }) },
  );
  const scan = result.scans.find((s) => s.chainId === 1);
  assert.equal(scan.status, "ok");
  assert.equal(scan.method, "direct-probe");
  assert.equal(result.approvals.length, 1, "the fallback must still find live approvals");
});

test("an owner address is required and malformed input is refused", async () => {
  await assert.rejects(() => approvalsScan({ owner: "not-an-address" }, {}), /valid EVM address/);
  await assert.rejects(() => approvalsScan({}, {}), /valid EVM address/);
});

test("the scan reports read-only provenance", async () => {
  const health = await approvalsHealth();
  assert.equal(health.readOnly, true);
  const result = await approvalsScan(
    { owner: OWNER, chainIds: [1] },
    { fetchImpl: stubFetch({}) },
  );
  assert.equal(result.readOnly, true);
});

test("the approvals provider cannot sign or broadcast", () => {
  for (const forbidden of [
    "eth_sendRawTransaction",
    "eth_sendTransaction",
    "eth_sign",
    "signTransaction",
    "privateKey",
    "mnemonic",
    "Wallet(",
  ]) {
    assert.ok(
      !SOURCE.includes(forbidden),
      `approvals provider must not reference ${forbidden}`,
    );
  }
});

// --- cost of a scan -------------------------------------------------------
//
// This provider runs against public RPC endpoints that rate-limit aggressively,
// so the number of calls a scan makes is a correctness property, not a detail.
// These tests count real stub invocations rather than asserting on timing.

/** stubFetch wrapper that records every JSON-RPC method it serves. */
function countingStub(options = {}) {
  const calls = [];
  const inner = stubFetch(options);
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: body.method, to: body.params?.[0]?.to, data: body.params?.[0]?.data });
    return inner(url, init);
  };
  return {
    impl,
    calls,
    count: (method) => calls.filter((c) => c.method === method).length,
    metadataCalls: () =>
      calls.filter(
        (c) =>
          c.method === "eth_call" &&
          (String(c.data).startsWith("0x313ce567") || String(c.data).startsWith("0x95d89b41")),
      ),
  };
}

test("token metadata is read once per token, not once per approval", async () => {
  clearApprovalsCache();
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const spenders = [
    "0x000000000022d473030f116ddee9f6b43ac78ba3",
    "0x1111111254eeb25477b68fb85ed929f73a960582",
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
    "0xe592427a0aece92de3edee1f18e0157c05861564",
  ];
  // Log discovery yields pairs with no bundled symbol, so each one would
  // otherwise trigger its own decimals()+symbol() read.
  const logs = spenders.map((spender) => ({
    address: weth,
    topics: ["0x", "0x", `0x${spender.slice(2).padStart(64, "0")}`],
  }));
  const stub = countingStub({
    logsFail: false,
    logs,
    allowances: Object.fromEntries(spenders.map((s) => [`${weth}:${s}`, 5_000n])),
  });

  const result = await approvalsScan({ owner: OWNER, chainIds: [1] }, { fetchImpl: stub.impl });

  assert.equal(result.approvals.length, 4, "all four approvals must still be found");
  assert.equal(
    stub.metadataCalls().length,
    2,
    "one decimals() + one symbol() for the shared token, not one pair per approval",
  );
});

test("a chain with no log access and no candidate tokens is skipped, not re-probed", async () => {
  clearApprovalsCache();
  // Chain 56 is configured but carries no CANDIDATE_TOKENS entry, so once the
  // endpoint has refused eth_getLogs there is nothing left for it to find.
  const first = countingStub({ logsFail: true });
  const a = await approvalsScan(
    { owner: OWNER, chainIds: [56] },
    { fetchImpl: first.impl, cache: true },
  );
  assert.equal(a.scans[0].status, "unconfigured");
  assert.ok(first.calls.length > 0, "the first scan must actually attempt discovery");

  const second = countingStub({ logsFail: true });
  const b = await approvalsScan(
    { owner: OWNER, chainIds: [56], refresh: true },
    { fetchImpl: second.impl, cache: true },
  );
  assert.equal(b.scans[0].status, "unconfigured");
  assert.equal(second.calls.length, 0, "a known-dead chain must cost zero RPC calls");
  clearApprovalsCache();
});

test("a repeat scan inside the TTL is served from cache and costs nothing", async () => {
  clearApprovalsCache();
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const opts = { allowances: { [`${usdc}:${permit2}`]: UINT256_MAX }, logsFail: true };

  const first = countingStub(opts);
  const a = await approvalsScan(
    { owner: OWNER, chainIds: [1] },
    { fetchImpl: first.impl, cache: true },
  );
  assert.equal(a.cached, false);
  assert.ok(first.calls.length > 0);

  const second = countingStub(opts);
  const b = await approvalsScan(
    { owner: OWNER, chainIds: [1] },
    { fetchImpl: second.impl, cache: true },
  );
  assert.equal(b.cached, true, "the second scan inside the TTL must be served from cache");
  assert.equal(second.calls.length, 0, "a cached scan must issue no RPC calls");
  assert.equal(b.approvals.length, a.approvals.length);

  // An explicit user reload must always reach the chain.
  const third = countingStub(opts);
  const c = await approvalsScan(
    { owner: OWNER, chainIds: [1], refresh: true },
    { fetchImpl: third.impl, cache: true },
  );
  assert.equal(c.cached, false, "refresh must bypass the cache");
  assert.ok(third.calls.length > 0, "refresh must actually re-read the chain");
  clearApprovalsCache();
});

test("caching never leaks one owner's result to another", async () => {
  clearApprovalsCache();
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const other = "0x00000000219ab540356cbb839cbe05303d7705fa";

  await approvalsScan(
    { owner: OWNER, chainIds: [1] },
    { fetchImpl: stubFetch({ allowances: { [`${usdc}:${permit2}`]: UINT256_MAX } }), cache: true },
  );
  const second = await approvalsScan(
    { owner: other, chainIds: [1] },
    { fetchImpl: stubFetch({ allowances: {} }), cache: true },
  );

  assert.equal(second.cached, false, "a different owner must never hit the first owner's entry");
  assert.equal(second.owner, other.toLowerCase());
  assert.equal(second.approvals.length, 0);
  clearApprovalsCache();
});

test("an injected transport does not populate the shared cache by default", async () => {
  clearApprovalsCache();
  const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const opts = { allowances: { [`${usdc}:${permit2}`]: UINT256_MAX }, logsFail: true };

  await approvalsScan({ owner: OWNER, chainIds: [1] }, { fetchImpl: stubFetch(opts) });
  const second = countingStub(opts);
  const b = await approvalsScan({ owner: OWNER, chainIds: [1] }, { fetchImpl: second.impl });

  assert.equal(b.cached, false, "a stubbed scan must not be served a cached answer");
  assert.ok(second.calls.length > 0, "the second stubbed scan must reach its own transport");
});

