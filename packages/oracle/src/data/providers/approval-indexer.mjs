// Optional approval discovery over an operator-provided, log-capable RPC.

import { rpcBlockNumber, rpcCall } from "./evm-rpc.mjs";

const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f714f36bb9e38e3b50c1acb8cdb4f8f6ebc8bb5d3b925";
const APPROVAL_FOR_ALL_TOPIC = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const DEFAULT_CHUNK_SPAN = 10_000;

function rpcUrlFor(chainId) {
  try {
    const specific = process.env[`ORACLE_INDEXER_RPC_${String(chainId)}`]?.trim();
    return specific || process.env.ORACLE_INDEXER_RPC_DEFAULT?.trim() || null;
  } catch {
    return null;
  }
}

export function indexerConfigured(chainId) {
  return Boolean(rpcUrlFor(chainId));
}

function addressTopic(owner) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error("invalid owner");
  return `0x${owner.slice(2).toLowerCase().padStart(64, "0")}`;
}

function topicAddress(topic) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) throw new Error("malformed topic");
  return `0x${topic.slice(-40).toLowerCase()}`;
}

function blockNumber(value) {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("malformed block number");
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed)) throw new Error("malformed block number");
  return parsed;
}

function parseLog(log) {
  if (!log || typeof log !== "object" || !Array.isArray(log.topics)) {
    throw new Error("malformed log");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(log.address)) throw new Error("malformed address");
  const token = log.address.toLowerCase();
  const topic0 = String(log.topics[0] || "").toLowerCase();
  const lastBlock = blockNumber(log.blockNumber);
  if (topic0 === APPROVAL_TOPIC.toLowerCase()) {
    if (log.topics.length < 3) throw new Error("malformed log");
    return {
      key: `erc20:${token}:${topicAddress(log.topics[2])}`,
      pair: { token, spender: topicAddress(log.topics[2]), standard: "erc20", lastBlock },
    };
  }
  if (topic0 === APPROVAL_FOR_ALL_TOPIC.toLowerCase()) {
    if (log.topics.length < 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) {
      throw new Error("malformed log");
    }
    const operator = topicAddress(log.topics[2]);
    return {
      key: `erc721:${token}:${operator}`,
      pair: {
        token,
        operator,
        standard: "erc721",
        approved: BigInt(log.data) !== 0n,
        lastBlock,
      },
    };
  }
  throw new Error("unexpected topic");
}

function failure(reason) {
  return { ok: false, method: "indexer", reason, pairs: [] };
}

/**
 * Logs discover candidate pairs only. The caller must read allowance() or
 * isApprovedForAll() because historical events do not establish live state.
 */
export async function indexApprovals({ chainId, owner, lookbackBlocks } = {}, opts = {}) {
  const rpcUrl = rpcUrlFor(chainId);
  if (!rpcUrl) return failure("not configured");

  try {
    const ownerFilter = addressTopic(owner);
    const lookback = Math.max(0, Math.floor(Number(lookbackBlocks)));
    if (!Number.isSafeInteger(lookback)) return failure("invalid lookback");
    const configuredSpan = Number(opts.chunkSpan ?? process.env.ORACLE_INDEXER_CHUNK_SPAN);
    const chunkSpan = Number.isSafeInteger(configuredSpan) && configuredSpan > 0
      ? configuredSpan
      : DEFAULT_CHUNK_SPAN;
    const rpcOpts = { ...opts, rpcUrl };
    delete rpcOpts.chunkSpan;
    const toBlock = await rpcBlockNumber(Number(chainId), rpcOpts);
    if (!Number.isSafeInteger(toBlock) || toBlock < 0) return failure("bad block number");
    const fromBlock = Math.max(0, toBlock - lookback);
    const latest = new Map();
    let succeeded = 0;

    for (let chunkTo = toBlock; chunkTo >= fromBlock;) {
      const chunkFrom = Math.max(fromBlock, chunkTo - chunkSpan + 1);
      try {
        const logs = await rpcCall(Number(chainId), "eth_getLogs", [{
          fromBlock: `0x${chunkFrom.toString(16)}`,
          toBlock: `0x${chunkTo.toString(16)}`,
          topics: [[APPROVAL_TOPIC, APPROVAL_FOR_ALL_TOPIC], ownerFilter],
        }], rpcOpts);
        if (!Array.isArray(logs)) throw new Error("malformed response");
        for (const log of logs) {
          const entry = parseLog(log);
          const prior = latest.get(entry.key);
          if (!prior || entry.pair.lastBlock >= prior.lastBlock) latest.set(entry.key, entry.pair);
        }
        succeeded += 1;
      } catch {
        if (succeeded === 0) return failure("rpc error");
        break;
      }
      chunkTo = chunkFrom - 1;
    }

    return {
      ok: true,
      method: "indexer",
      fromBlock,
      toBlock,
      pairs: [...latest.values()],
    };
  } catch {
    return failure("invalid request");
  }
}
