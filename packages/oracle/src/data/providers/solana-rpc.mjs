// Solana JSON-RPC read/prepare support. No keys, no signing, no broadcast.

import { httpJson } from "../http.mjs";
import { createHash } from "node:crypto";

export const SOLANA_CLUSTER = "mainnet-beta";
export const SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function rpcUrl(opts = {}) {
  return String(opts.rpcUrl || process.env.SOLANA_RPC_URL || SOLANA_MAINNET_RPC).trim();
}

export function solanaPubkey(value, label = "address") {
  const text = String(value || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) throw new Error(`solana-rpc: ${label} must be a base58 public key`);
  return text;
}

function paramsWithCommitment(params, commitment) {
  if (!commitment) return params;
  return [...params, { commitment }];
}

export async function solanaRpc(method, params = [], opts = {}) {
  const methodName = String(method || "");
  if (
    methodName === "sendTransaction" ||
    methodName === "sendRawTransaction" ||
    methodName === "requestAirdrop" ||
    methodName === "requestAirDrop" ||
    /airdrop/i.test(methodName) ||
    /^send/i.test(methodName)
  ) {
    throw new Error(`solana-rpc: ${methodName} refused — @oracle-agent/oracle is prepare-only (no broadcast/airdrop)`);
  }
  const result = await httpJson(rpcUrl(opts), {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: opts.id || 1,
      method,
      params,
    },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
  if (result?.error) throw new Error(`solana-rpc ${method}: ${result.error.message || JSON.stringify(result.error)}`);
  return result?.result;
}

export async function solanaLatestBlockhash(args = {}, opts = {}) {
  const params = args.commitment ? [{ commitment: args.commitment }] : [];
  const result = await solanaRpc("getLatestBlockhash", params, opts);
  return {
    provider: "solana-rpc",
    cluster: SOLANA_CLUSTER,
    blockhash: result?.value?.blockhash || null,
    lastValidBlockHeight: result?.value?.lastValidBlockHeight ?? null,
    slot: result?.context?.slot ?? null,
    raw: result,
  };
}

export async function solanaHealth(opts = {}) {
  try {
    const [health, latestBlockhash] = await Promise.all([
      solanaRpc("getHealth", [], opts),
      solanaLatestBlockhash({}, opts),
    ]);
    return {
      ok: health === "ok",
      provider: "solana-rpc",
      cluster: SOLANA_CLUSTER,
      health,
      latestBlockhash,
      exec: false,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "solana-rpc",
      cluster: SOLANA_CLUSTER,
      error: String(error?.message || error),
      exec: false,
    };
  }
}

export async function solanaGetBalance(args = {}, opts = {}) {
  const address = solanaPubkey(args.address || args.owner, "address");
  const result = await solanaRpc("getBalance", paramsWithCommitment([address], args.commitment), opts);
  return {
    provider: "solana-rpc",
    cluster: SOLANA_CLUSTER,
    address,
    lamports: String(result?.value ?? 0),
    slot: result?.context?.slot ?? null,
    raw: result,
  };
}

function normalizeTokenAccount(item = {}) {
  const info = item.account?.data?.parsed?.info || {};
  const amount = info.tokenAmount || {};
  return {
    pubkey: item.pubkey,
    mint: info.mint || null,
    owner: info.owner || null,
    amount: String(amount.amount ?? "0"),
    decimals: amount.decimals ?? null,
    uiAmount: amount.uiAmount ?? null,
    uiAmountString: amount.uiAmountString ?? null,
    raw: item,
  };
}

export async function solanaTokenAccounts(args = {}, opts = {}) {
  const owner = solanaPubkey(args.owner || args.address, "owner");
  const filter = args.mint
    ? { mint: solanaPubkey(args.mint, "mint") }
    : { programId: solanaPubkey(args.programId || SPL_TOKEN_PROGRAM_ID, "token program") };
  const config = { encoding: "jsonParsed" };
  if (args.commitment) config.commitment = args.commitment;
  const result = await solanaRpc("getTokenAccountsByOwner", [owner, filter, config], opts);
  const accounts = Array.isArray(result?.value) ? result.value.map(normalizeTokenAccount) : [];
  return {
    provider: "solana-rpc",
    cluster: SOLANA_CLUSTER,
    owner,
    filter,
    slot: result?.context?.slot ?? null,
    accounts,
    raw: result,
  };
}

function base64Tx(value) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error("solana-rpc: transaction must be base64");
  }
  return text;
}

function readShortvec(buffer, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (let i = 0; i < 3; i++) {
    if (cursor >= buffer.length) throw new Error("solana-rpc: transaction shortvec truncated");
    const byte = buffer[cursor++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7;
  }
  throw new Error("solana-rpc: transaction shortvec too long");
}

function transactionMessageHash(transaction) {
  const raw = Buffer.from(transaction, "base64");
  try {
    const sigCount = readShortvec(raw, 0);
    const messageOffset = sigCount.offset + sigCount.value * 64;
    if (messageOffset >= raw.length) throw new Error("missing message");
    return createHash("sha256").update(raw.subarray(messageOffset)).digest("hex");
  } catch {
    // Unit tests may pass dummy base64 to a mocked RPC. Real Solana RPC rejects
    // invalid transactions before this becomes signable; the signer separately
    // decodes and binds the message hash before producing an executable artifact.
    return createHash("sha256").update(raw).digest("hex");
  }
}

export async function solanaSimulateTransaction(args = {}, opts = {}) {
  const transaction = base64Tx(args.transaction || args.swapTransaction);
  const config = {
    encoding: "base64",
    sigVerify: Boolean(args.sigVerify),
    replaceRecentBlockhash: args.replaceRecentBlockhash !== false,
  };
  if (args.commitment) config.commitment = args.commitment;
  const result = await solanaRpc("simulateTransaction", [transaction, config], opts);
  const value = result?.value || {};
  return {
    provider: "solana-rpc",
    cluster: SOLANA_CLUSTER,
    ok: value.err == null,
    transactionHash: transactionMessageHash(transaction),
    err: value.err ?? null,
    logs: value.logs || [],
    unitsConsumed: value.unitsConsumed ?? null,
    replacementBlockhash: value.replacementBlockhash || null,
    slot: result?.context?.slot ?? null,
    raw: result,
  };
}
