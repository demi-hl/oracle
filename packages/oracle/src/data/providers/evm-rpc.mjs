// EVM JSON-RPC read pack — multi-chain balances/blocks via public or env RPCs.
// No wallet keys. Uses chain registry rpcEnv + optional public fallbacks.

import { httpJson } from "../http.mjs";
import { CHAINS, chainById, rpcUrlFor, isSupportedChain } from "../../chains.mjs";
import { Interface, getAddress } from "ethers";

const ERC20 = new Interface([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
]);

function normalizeAddress(value, label) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new Error(`${label} must be a valid EVM address`);
  }
}

function normalizeTxHash(value) {
  const hash = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("txHash must be a 32-byte hex transaction hash");
  return hash.toLowerCase();
}

function parseHexInt(value) {
  if (value == null) return null;
  return Number.parseInt(String(value), 16);
}

/** Public fallbacks when env RPC unset — rate-limited, fine for health/read. */
export const PUBLIC_RPC_FALLBACKS = {
  1: "https://ethereum.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  988: "https://rpc.stable.xyz",
  56: "https://bsc-rpc.publicnode.com",
  43114: "https://avalanche-c-chain-rpc.publicnode.com",
  999: "https://rpc.hyperliquid.xyz/evm",
  2741: "https://api.mainnet.abs.xyz",
  4663: "https://rpc.mainnet.chain.robinhood.com",
};

/**
 * Resolve RPC URL for a chainId: explicit > env (registry) > public fallback.
 */
export function resolveRpcUrl(chainId, { rpcUrl, env = process.env } = {}) {
  if (rpcUrl) return rpcUrl;
  const fromEnv = rpcUrlFor(chainId, env);
  if (fromEnv) return fromEnv;
  return PUBLIC_RPC_FALLBACKS[Number(chainId)] || null;
}

/**
 * JSON-RPC call
 * @param {number} chainId
 * @param {string} method
 * @param {any[]} [params]
 */

// `rpcCall` is the raw public transport exposed by the data facade. It must be
// an allowlist, not a partial write denylist: every unrecognized method is
// unsafe to forward because vendors add write namespaces (`wallet_send*`,
// `pm_sendUserOperation`, `mev_sendBundle`) faster than a denylist stays fresh.
//
// Canonical JSON-RPC method names are ASCII lowercase + underscores. Reject
// whitespace, separator tricks, and Unicode homoglyphs rather than normalizing
// them into a different network request.
const EVM_READ_RPC = /^(?:eth_(?:call|blocknumber|chainid|get[a-z0-9]+|feehistory|gasprice|maxpriorityfeepergas|syncing|protocolversion|estimategas|createaccesslist)|net_(?:version|listening|peercount)|web3_(?:clientversion|sha3))$/;

function readRpcMethod(method) {
  const raw = String(method || "");
  const probe = raw.toLowerCase();
  if (raw !== raw.trim() || !/^[a-zA-Z0-9_]+$/.test(raw) || !EVM_READ_RPC.test(probe)) {
    throw new Error(`evm-rpc: ${raw} refused — @oracle-agent/oracle is prepare-only (read RPC only; no broadcast/sign)`);
  }
  return probe;
}

export async function rpcCall(chainId, method, params = [], opts = {}) {
  const methodName = String(method || "");
  readRpcMethod(methodName);
  const url = resolveRpcUrl(chainId, opts);
  if (!url) {
    throw new Error(
      `No RPC URL for chainId ${chainId} (set env from chain registry rpcEnv or pass rpcUrl)`
    );
  }
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const res = await httpJson(url, {
    method: "POST",
    body,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
  if (res?.error) {
    const err = new Error(res.error.message || JSON.stringify(res.error));
    err.code = res.error.code;
    throw err;
  }
  return res.result;
}

export async function rpcHealth(chainId, opts = {}) {
  const blockHex = await rpcCall(chainId, "eth_blockNumber", [], opts);
  const block = parseInt(blockHex, 16);
  const idHex = await rpcCall(chainId, "eth_chainId", [], opts);
  const reported = parseInt(idHex, 16);
  return {
    ok: Number.isFinite(block) && reported === Number(chainId),
    chainId: Number(chainId),
    reportedChainId: reported,
    blockNumber: block,
    name: chainById(chainId)?.name || null,
  };
}

export async function rpcBlockNumber(chainId, opts = {}) {
  const hex = await rpcCall(chainId, "eth_blockNumber", [], opts);
  return parseInt(hex, 16);
}

export async function rpcChainId(chainId, opts = {}) {
  const hex = await rpcCall(chainId, "eth_chainId", [], opts);
  return parseInt(hex, 16);
}

export async function rpcGetBalance(chainId, address, opts = {}) {
  if (!address) throw new Error("rpcGetBalance requires address");
  const hex = await rpcCall(chainId, "eth_getBalance", [address, "latest"], opts);
  return { chainId: Number(chainId), address, balanceWei: BigInt(hex).toString(), balanceHex: hex };
}

export async function erc20Allowance(args = {}, opts = {}) {
  const chainId = Number(args.chainId ?? opts.chainId ?? 1);
  const token = normalizeAddress(args.token || args.tokenAddress, "token");
  const owner = normalizeAddress(args.owner, "owner");
  const spender = normalizeAddress(args.spender, "spender");
  const data = ERC20.encodeFunctionData("allowance", [owner, spender]);
  const result = await rpcCall(chainId, "eth_call", [{ to: token, data }, args.blockTag || "latest"], opts);
  const decoded = ERC20.decodeFunctionResult("allowance", result);
  const allowance = BigInt(decoded[0]);
  return {
    chainId,
    token,
    owner,
    spender,
    allowance: allowance.toString(),
    allowanceHex: `0x${allowance.toString(16)}`,
    blockTag: args.blockTag || "latest",
  };
}

export async function erc20BalanceOf(args = {}, opts = {}) {
  const chainId = Number(args.chainId ?? opts.chainId ?? 1);
  const token = normalizeAddress(args.token || args.tokenAddress, "token");
  const account = normalizeAddress(args.account || args.owner || args.address, "account");
  const data = ERC20.encodeFunctionData("balanceOf", [account]);
  const result = await rpcCall(chainId, "eth_call", [{ to: token, data }, args.blockTag || "latest"], opts);
  const decoded = ERC20.decodeFunctionResult("balanceOf", result);
  const balance = BigInt(decoded[0]);
  return {
    chainId,
    token,
    account,
    balance: balance.toString(),
    balanceHex: `0x${balance.toString(16)}`,
    blockTag: args.blockTag || "latest",
  };
}

export async function transactionReceipt(args = {}, opts = {}) {
  const chainId = Number(args.chainId ?? opts.chainId ?? 1);
  const txHash = normalizeTxHash(args.txHash || args.hash || args.transactionHash);
  const receipt = await rpcCall(chainId, "eth_getTransactionReceipt", [txHash], opts);
  if (!receipt) {
    return { ok: false, chainId, txHash, status: "pending", receipt: null, reason: "receipt pending" };
  }
  const statusNumber = parseHexInt(receipt.status);
  let ok = statusNumber === 1;
  const status = statusNumber === 1 ? "success" : statusNumber === 0 ? "reverted" : "unknown";
  let reason = ok ? null : status === "reverted" ? "transaction reverted" : "unknown receipt status";
  const expectedTo = args.expectedTo ? normalizeAddress(args.expectedTo, "expectedTo") : null;
  const actualTo = receipt.to ? normalizeAddress(receipt.to, "receipt.to") : null;
  if (expectedTo && actualTo !== expectedTo) {
    ok = false;
    reason = `to mismatch: expected ${expectedTo}, got ${actualTo || "null"}`;
  }
  return {
    ok,
    chainId,
    txHash,
    status,
    reason,
    statusCode: statusNumber,
    to: actualTo,
    from: receipt.from ? normalizeAddress(receipt.from, "receipt.from") : null,
    blockNumber: parseHexInt(receipt.blockNumber),
    transactionIndex: parseHexInt(receipt.transactionIndex),
    logs: Array.isArray(receipt.logs) ? receipt.logs : [],
    receipt,
  };
}

export async function rpcHealthAll(opts = {}) {
  const ids = opts.chainIds || Object.values(CHAINS).map((c) => c.chainId);
  const out = {};
  await Promise.all(
    ids.map(async (id) => {
      if (!isSupportedChain(id) && !PUBLIC_RPC_FALLBACKS[id] && !resolveRpcUrl(id, opts)) {
        out[id] = { ok: false, error: "no rpc configured", chainId: id };
        return;
      }
      try {
        out[id] = await rpcHealth(id, opts);
      } catch (e) {
        out[id] = { ok: false, chainId: id, error: String(e.message || e) };
      }
    })
  );
  return out;
}
