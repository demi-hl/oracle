import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { indexApprovals, indexerConfigured } from "../src/data/providers/approval-indexer.mjs";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SPENDER = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const OPERATOR = "0x1e0049783f008a0085193e00003d00cd54003c71";
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f714f36bb9e38e3b50c1acb8cdb4f8f6ebc8bb5d3b925";
const APPROVAL_FOR_ALL_TOPIC = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";

const topic = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

afterEach(() => {
  delete process.env.ORACLE_INDEXER_RPC_1;
  delete process.env.ORACLE_INDEXER_RPC_DEFAULT;
});

function stubFetch({ head = 20, logs = [], status = 200, malformed = false } = {}) {
  const calls = [];
  const impl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (status !== 200) {
      return { ok: false, status, headers: { get: () => "text/plain" }, text: async () => "refused" };
    }
    const result = body.method === "eth_blockNumber" ? `0x${head.toString(16)}` : malformed ? {} : logs;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
    };
  };
  return { impl, calls };
}

function approvalLog({ block = 1, spender = SPENDER } = {}) {
  return { address: TOKEN, blockNumber: `0x${block.toString(16)}`, topics: [APPROVAL_TOPIC, topic(OWNER), topic(spender)], data: word(1) };
}

function operatorLog({ block = 1, approved = true } = {}) {
  return { address: TOKEN, blockNumber: `0x${block.toString(16)}`, topics: [APPROVAL_FOR_ALL_TOPIC, topic(OWNER), topic(OPERATOR)], data: word(approved ? 1 : 0) };
}

test("indexerConfigured reflects chain-specific and default configuration", () => {
  assert.equal(indexerConfigured(1), false);
  process.env.ORACLE_INDEXER_RPC_DEFAULT = "https://indexer.invalid";
  assert.equal(indexerConfigured(1), true);
  delete process.env.ORACLE_INDEXER_RPC_DEFAULT;
  process.env.ORACLE_INDEXER_RPC_1 = "https://indexer.invalid";
  assert.equal(indexerConfigured(1), true);
});

test("a clean two-log response produces two pairs", async () => {
  process.env.ORACLE_INDEXER_RPC_1 = "https://indexer.invalid";
  const stub = stubFetch({ logs: [approvalLog(), operatorLog()] });
  const result = await indexApprovals({ chainId: 1, owner: OWNER, lookbackBlocks: 10 }, { fetchImpl: stub.impl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pairs, [
    { token: TOKEN, spender: SPENDER, standard: "erc20", lastBlock: 1 },
    { token: TOKEN, operator: OPERATOR, standard: "erc721", approved: true, lastBlock: 1 },
  ]);
});

test("the latest event supersedes an earlier pair event", async () => {
  process.env.ORACLE_INDEXER_RPC_1 = "https://indexer.invalid";
  const stub = stubFetch({ logs: [approvalLog({ block: 4 }), approvalLog({ block: 9 })] });
  const result = await indexApprovals({ chainId: 1, owner: OWNER, lookbackBlocks: 10 }, { fetchImpl: stub.impl });
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].lastBlock, 9);
});

test("a false ApprovalForAll event is returned", async () => {
  process.env.ORACLE_INDEXER_RPC_1 = "https://indexer.invalid";
  const stub = stubFetch({ logs: [operatorLog({ approved: false })] });
  const result = await indexApprovals({ chainId: 1, owner: OWNER, lookbackBlocks: 10 }, { fetchImpl: stub.impl });
  assert.equal(result.pairs[0].approved, false);
});

test("a refused endpoint returns a failure and never throws", async () => {
  process.env.ORACLE_INDEXER_RPC_1 = "https://indexer.invalid";
  const result = await indexApprovals({ chainId: 1, owner: OWNER, lookbackBlocks: 10 }, { fetchImpl: stubFetch({ status: 403 }).impl });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
  assert.deepEqual(result.pairs, []);
});

test("a malformed log response returns a failure and never throws", async () => {
  process.env.ORACLE_INDEXER_RPC_1 = "https://indexer.invalid";
  const result = await indexApprovals({ chainId: 1, owner: OWNER, lookbackBlocks: 10 }, { fetchImpl: stubFetch({ malformed: true }).impl });
  assert.equal(result.ok, false);
  assert.deepEqual(result.pairs, []);
});

test("large ranges are split into bounded backward queries", async () => {
  process.env.ORACLE_INDEXER_RPC_1 = "https://indexer.invalid";
  const stub = stubFetch({ head: 25 });
  const result = await indexApprovals({ chainId: 1, owner: OWNER, lookbackBlocks: 25 }, { fetchImpl: stub.impl, chunkSpan: 10 });
  assert.equal(result.ok, true);
  const queries = stub.calls.filter((call) => call.method === "eth_getLogs");
  assert.equal(queries.length, 3);
  assert.deepEqual(queries.map((call) => [call.params[0].fromBlock, call.params[0].toBlock]), [["0x10", "0x19"], ["0x6", "0xf"], ["0x0", "0x5"]]);
});

test("all issued RPC methods are read-only", async () => {
  process.env.ORACLE_INDEXER_RPC_1 = "https://indexer.invalid";
  const stub = stubFetch({ logs: [] });
  await indexApprovals({ chainId: 1, owner: OWNER, lookbackBlocks: 10 }, { fetchImpl: stub.impl });
  assert.deepEqual([...new Set(stub.calls.map((call) => call.method))].sort(), ["eth_blockNumber", "eth_getLogs"]);
});
