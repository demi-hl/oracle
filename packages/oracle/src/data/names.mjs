// Cross-chain name resolution. Read-only by construction: every lookup goes
// through rpcCall(), whose allowlist refuses anything that is not a read
// method, so this module cannot sign or broadcast even by mistake.
//
// No API keys. HL Names publishes a REST API that requires one, but the
// contract answers primaryName(address) for free, and the MetaMask snap is
// only a proxy for that same paid endpoint. Reading the chain is cheaper and
// has one less party to trust. Ported from the resolution chain already proven
// in DEMI's polymarket bot (src/hooks/useResolveName.js).
//
// Verified live 2026-08-05 against 0x4d47b6757afd42c3dbd9691b71b43d74afa4b6b2:
//   .hl    -> demi.hl        .hype -> demi.hype
//   .eth   -> demigodzx.eth  .base -> (no record, call OK)

import { keccak_256 } from "@noble/hashes/sha3.js";
import { rpcCall } from "./providers/evm-rpc.mjs";

const HYPEREVM = 999;
const MAINNET = 1;
const BASE = 8453;

const HLNAMES = "0x1d9d87eBc14e71490bB87f1C39F65BDB979f3cb7";
const DOTHYPE_RESOLVER = "0x4d5e4ed4D5e4A160Fa136853597cDc2eBBe66494";
const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const BASE_L2_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD";

// Base reverse records live under a chain-specific reverse namespace, not
// .addr.reverse: 0x80002105 is the ENSIP-11 coinType for Base.
const BASE_REVERSE_SUFFIX = ".80002105.reverse";

export const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const enc = new TextEncoder();
const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const selector = (sig) => hex(keccak_256(enc.encode(sig))).slice(0, 10);
const padAddress = (addr) => addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");

export function namehash(name) {
  let node = new Uint8Array(32);
  if (name) {
    for (const label of String(name).split(".").reverse()) {
      const labelHash = keccak_256(enc.encode(label));
      const joined = new Uint8Array(64);
      joined.set(node, 0);
      joined.set(labelHash, 32);
      node = keccak_256(joined);
    }
  }
  return hex(node);
}

// ABI-decode a single dynamic string. Returns "" for empty/zero results so a
// name that simply is not registered reads the same as a contract that
// returned nothing, which is what every caller wants.
export function decodeAbiString(raw) {
  if (!raw || raw === "0x" || /^0x0*$/.test(raw)) return "";
  try {
    const body = raw.slice(2);
    const offset = parseInt(body.slice(0, 64), 16) * 2;
    const length = parseInt(body.slice(offset, offset + 64), 16);
    if (!Number.isFinite(length) || length <= 0) return "";
    const chars = body.slice(offset + 64, offset + 64 + length * 2);
    return Buffer.from(chars, "hex").toString("utf8");
  } catch {
    return "";
  }
}

export function encodeAbiString(value) {
  const bytes = enc.encode(String(value));
  const len = bytes.length.toString(16).padStart(64, "0");
  const padded = Buffer.from(bytes).toString("hex").padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return "0000000000000000000000000000000000000000000000000000000000000020" + len + padded;
}

async function ethCall(chainId, to, data) {
  try {
    return await rpcCall(chainId, "eth_call", [{ to, data }, "latest"]);
  } catch {
    // A dead RPC must not take down the whole chain of lookups: a missing
    // .hl answer should still let .eth resolve.
    return null;
  }
}

async function reverseHl(address) {
  const raw = await ethCall(HYPEREVM, HLNAMES, selector("primaryName(address)") + padAddress(address));
  const name = decodeAbiString(raw);
  if (!name) return null;
  return name.endsWith(".hl") ? name : `${name}.hl`;
}

async function reverseHype(address) {
  const raw = await ethCall(HYPEREVM, DOTHYPE_RESOLVER, selector("getName(address)") + padAddress(address));
  const name = decodeAbiString(raw);
  if (!name) return null;
  return name.endsWith(".hype") ? name : `${name}.hype`;
}

async function reverseVia(chainId, node, resolverAddress) {
  const raw = await ethCall(chainId, resolverAddress, selector("name(bytes32)") + node.slice(2));
  return decodeAbiString(raw) || null;
}

async function reverseEns(address) {
  const node = namehash(`${address.slice(2).toLowerCase()}.addr.reverse`);
  const resolverRaw = await ethCall(MAINNET, ENS_REGISTRY, selector("resolver(bytes32)") + node.slice(2));
  if (!resolverRaw) return null;
  const resolver = "0x" + resolverRaw.slice(-40);
  if (/^0x0+$/.test(resolver)) return null;
  return reverseVia(MAINNET, node, resolver);
}

async function reverseBasename(address) {
  const node = namehash(address.slice(2).toLowerCase() + BASE_REVERSE_SUFFIX);
  return reverseVia(BASE, node, BASE_L2_RESOLVER);
}

// Priority mirrors the polymarket bot: Hyperliquid-native names first because
// this is DEMI's primary venue, then ENS, then Base.
const REVERSE_ORDER = [
  { source: "hl", fn: reverseHl },
  { source: "hype", fn: reverseHype },
  { source: "ens", fn: reverseEns },
  { source: "basename", fn: reverseBasename },
];

/** address -> { name, source } | null */
export async function lookupName(address) {
  if (!ADDRESS_RE.test(String(address || "").trim())) return null;
  const addr = String(address).trim();
  for (const { source, fn } of REVERSE_ORDER) {
    const name = await fn(addr);
    if (name) return { name, source, address: addr };
  }
  return null;
}

// HLNames is an ERC721 whose tokenId IS the namehash, so forward resolution
// is ownerOf(namehash(name)) rather than a resolve()-style helper. Probed the
// whole plausible surface (resolve/resolveName/getAddress/addr/lookup, string
// and bytes32 forms) and every one returned empty; ownerOf(namehash("demi.hl"))
// returned DEMI's address, while ownerOf(labelhash("demi")) returned zero,
// which pins both the function AND the tokenId derivation.
async function forwardHl(name) {
  const node = namehash(name);
  const raw = await ethCall(HYPEREVM, HLNAMES, selector("ownerOf(uint256)") + node.slice(2));
  if (!raw || raw.length < 66) return null;
  const addr = "0x" + raw.slice(-40);
  return /^0x0+$/.test(addr) ? null : addr;
}

async function forwardEnsLike(chainId, name, registry) {
  const node = namehash(name);
  const resolverRaw = await ethCall(chainId, registry, selector("resolver(bytes32)") + node.slice(2));
  if (!resolverRaw) return null;
  const resolver = "0x" + resolverRaw.slice(-40);
  if (/^0x0+$/.test(resolver)) return null;
  const addrRaw = await ethCall(chainId, resolver, selector("addr(bytes32)") + node.slice(2));
  if (!addrRaw) return null;
  const addr = "0x" + addrRaw.slice(-40);
  return /^0x0+$/.test(addr) ? null : addr;
}

/** name -> { address, source } | null */
export async function resolveName(name) {
  const clean = String(name || "").trim().toLowerCase();
  if (!clean || !clean.includes(".")) return null;

  if (clean.endsWith(".hl")) {
    const address = await forwardHl(clean);
    return address ? { address, source: "hl", name: clean } : null;
  }
  if (clean.endsWith(".eth")) {
    const address = await forwardEnsLike(MAINNET, clean, ENS_REGISTRY);
    return address ? { address, source: clean.endsWith(".base.eth") ? "basename" : "ens", name: clean } : null;
  }
  return null;
}

/** Accepts either a raw address or a name and always yields an address. */
export async function toAddress(input) {
  const value = String(input || "").trim();
  if (ADDRESS_RE.test(value)) return { address: value, source: "address", name: null };
  return resolveName(value);
}

export const NAME_SOURCES = REVERSE_ORDER.map((r) => r.source);
