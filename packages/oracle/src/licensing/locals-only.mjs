import { Contract, JsonRpcProvider } from "ethers";

export const LOCALS_ONLY_CONTRACT = "0x62FCFAf7573AD8B41a0FBF347AfEb85e06599A75";
export const LOCALS_ONLY_CHAIN_ID = 999;
export const LOCALS_ONLY_RPC = "https://rpc.hyperliquid.xyz/evm";

const ERC721_BALANCE_ABI = ["function balanceOf(address owner) view returns (uint256)"];
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function isAddress(value) {
  return ADDRESS_RE.test(String(value || ""));
}

export async function holderBalance(address, {
  contract = LOCALS_ONLY_CONTRACT,
  rpc = LOCALS_ONLY_RPC,
  chainId = LOCALS_ONLY_CHAIN_ID,
  balanceOf,
} = {}) {
  if (!isAddress(address)) throw new Error("invalid-address");
  if (balanceOf) return BigInt(await balanceOf(address));
  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const erc721 = new Contract(contract, ERC721_BALANCE_ABI, provider);
  return BigInt(await erc721.balanceOf(address));
}
