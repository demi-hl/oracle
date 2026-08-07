// Morpho public GraphQL API — markets/vaults, no key. ERC-4626 vault
// prepare returns a guarded intent only; dynamic vault tx signing/submission is a
// later, separately gated execution step.

import { Interface, getAddress, isAddress, keccak256, toUtf8Bytes } from "ethers";
import { httpJson } from "../http.mjs";
import { rpcCall as defaultRpcCall } from "./evm-rpc.mjs";
import { stampPrepared } from "../../prepare-envelope.mjs";

export const MORPHO_API = "https://api.morpho.org/graphql";

const ERC4626 = new Interface([
  "function asset() view returns (address)",
  "function maxDeposit(address owner) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function deposit(uint256 assets,address receiver) returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function withdraw(uint256 assets,address receiver,address owner) returns (uint256)",
]);

const endpoint = (o = {}) => o.baseUrl || process.env.MORPHO_API_URL || MORPHO_API;

async function gql(query, variables, opts = {}) {
  return httpJson(endpoint(opts), {
    method: "POST",
    body: { query, variables },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

const MARKET_QUERY = `query Markets($first: Int, $where: MarketFilters) { markets(first: $first, where: $where) { items { marketId lltv listed loanAsset { address symbol decimals } collateralAsset { address symbol decimals } state { supplyAssetsUsd borrowAssetsUsd } } } }`;
const VAULT_QUERY = `query Vaults($first: Int, $where: VaultFilters) { vaults(first: $first, where: $where) { items { address name symbol listed asset { address symbol decimals } state { totalAssets totalAssetsUsd apy } } } }`;

function normalAddress(value, label) {
  const text = String(value || "").trim();
  if (!isAddress(text)) throw new Error(`morpho: ${label} must be an address`);
  return getAddress(text).toLowerCase();
}

function amountString(value, label = "amount") {
  try {
    const n = BigInt(String(value));
    if (n <= 0n) throw new Error("nonpositive");
    return n.toString();
  } catch {
    throw new Error(`morpho: ${label} must be a positive integer string`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function callVault(chainId, vault, fn, args, opts = {}) {
  const data = ERC4626.encodeFunctionData(fn, args);
  const call = opts.rpcCall || defaultRpcCall;
  const result = await call(Number(chainId), "eth_call", [{ to: vault, data }, "latest"], opts);
  return ERC4626.decodeFunctionResult(fn, result);
}

function listedVault(items, vault) {
  const target = vault.toLowerCase();
  return (items || []).find((item) => String(item?.address || "").toLowerCase() === target) || null;
}

export async function morphoMarkets(args = {}, opts = {}) {
  const first = Math.min(100, Math.max(1, Number(args.first || 20)));
  const chainIds = (args.chainIds || [args.chainId || 1]).map(Number);
  return gql(MARKET_QUERY, { first, chainIds, where: { chainId_in: chainIds } }, opts);
}

export async function morphoVaults(args = {}, opts = {}) {
  const first = Math.min(100, Math.max(1, Number(args.first || 20)));
  const chainIds = (args.chainIds || [args.chainId || 1]).map(Number);
  return gql(VAULT_QUERY, { first, chainIds, where: { chainId_in: chainIds } }, opts);
}

export async function morphoHealth(opts = {}) {
  const data = await gql("query { __typename }", {}, opts);
  return { ok: data?.data?.__typename === "Query" };
}

export async function morphoPrepareVault(args = {}, opts = {}) {
  const chainId = Number(args.chainId ?? 8453);
  const action = String(args.action || "deposit").toLowerCase();
  if (!["deposit", "withdraw"].includes(action)) throw new Error("morpho: action must be deposit or withdraw");
  const vault = normalAddress(args.vault || args.vaultAddress, "vault");
  const owner = normalAddress(args.owner || args.from || args.sender, "owner");
  const receiver = normalAddress(args.receiver || owner, "receiver");
  const amount = amountString(args.amount || args.assets, "amount");
  const minTotalAssetsUsd = Number(args.minTotalAssetsUsd ?? 100_000);

  const vaults = await morphoVaults({ chainId, first: 100 }, opts);
  const info = listedVault(vaults?.data?.vaults?.items, vault);
  if (!info) throw new Error("morpho: vault not found in public Morpho vault registry");
  if (info.listed === false) throw new Error("morpho: vault is not listed");
  const totalAssetsUsd = Number(info?.state?.totalAssetsUsd ?? 0);
  if (Number.isFinite(minTotalAssetsUsd) && totalAssetsUsd < minTotalAssetsUsd) {
    throw new Error(`morpho: vault totalAssetsUsd ${totalAssetsUsd} below minimum ${minTotalAssetsUsd}`);
  }

  const [assetOnchain] = await callVault(chainId, vault, "asset", [], opts);
  const asset = normalAddress(assetOnchain, "vault asset");
  const apiAsset = info?.asset?.address ? normalAddress(info.asset.address, "api vault asset") : asset;
  if (apiAsset !== asset) throw new Error("morpho: API asset and on-chain asset mismatch");

  let data;
  let floor;
  if (action === "deposit") {
    const [maxDeposit] = await callVault(chainId, vault, "maxDeposit", [owner], opts);
    if (BigInt(amount) > BigInt(maxDeposit.toString())) throw new Error("morpho: amount exceeds maxDeposit");
    const [sharesOut] = await callVault(chainId, vault, "previewDeposit", [amount], opts);
    if (BigInt(sharesOut.toString()) <= 0n) throw new Error("morpho: previewDeposit returned zero shares");
    floor = { minSharesOut: sharesOut.toString() };
    data = ERC4626.encodeFunctionData("deposit", [amount, receiver]);
  } else {
    const [maxWithdraw] = await callVault(chainId, vault, "maxWithdraw", [owner], opts);
    if (BigInt(amount) > BigInt(maxWithdraw.toString())) throw new Error("morpho: amount exceeds maxWithdraw");
    const [sharesIn] = await callVault(chainId, vault, "previewWithdraw", [amount], opts);
    if (BigInt(sharesIn.toString()) <= 0n) throw new Error("morpho: previewWithdraw returned zero shares");
    floor = { maxSharesIn: sharesIn.toString() };
    data = ERC4626.encodeFunctionData("withdraw", [amount, receiver, owner]);
  }

  const vaultGuard = {
    mode: "erc4626-vault",
    version: 1,
    provider: "morpho",
    chainId,
    action,
    vault,
    asset,
    owner,
    receiver,
    amount,
    totalAssetsUsd,
    ...floor,
    calldataHash: keccak256(toUtf8Bytes(data)),
    issuedAtMs: Date.now(),
    expiresAtMs: Date.now() + 20_000,
  };
  vaultGuard.guardHash = keccak256(toUtf8Bytes(canonicalJson(vaultGuard)));

  return stampPrepared({
    provider: "morpho",
    protocol: "erc4626-vault",
    vaultReady: true,
    executionReady: false,
    signingReady: false,
    broadcastReady: false,
    requiresUserSignature: true,
    chainId,
    action,
    vault,
    asset,
    owner,
    receiver,
    amount,
    vaultInfo: info,
    vaultGuard,
    requiresApproval: action === "deposit" ? { token: asset, spender: vault, amount } : null,
    transaction: {
      chainId,
      from: owner,
      to: vault,
      data,
      value: "0x0",
      madVault: vaultGuard,
    },
  }, { provider: "morpho", kind: "erc4626-vault" });
}
