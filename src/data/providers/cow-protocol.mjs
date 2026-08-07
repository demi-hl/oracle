// CoW Protocol public Orderbook API — intent/solver-based DEX reads, no key.
//
// Read-only. This module never posts an order: CoW order creation is a signed
// EIP-712 intent, which belongs on the prepare/exec plane (see cowswap.mjs),
// not here.
//
// Endpoint reality, probed live 2026-08-06:
//   GET /api/v1/version                      -> 200 (cheap liveness probe)
//   GET /api/v1/account/{owner}/orders       -> 200 (owner-scoped order book)
//   GET /api/v1/trades?owner=0x..            -> 200 (owner or orderUid REQUIRED;
//                                               the unfiltered form returns
//                                               InvalidTradeFilter)
//   GET /api/v1/auction                      -> 403 at the CloudFront edge for
//                                               non-browser clients on EVERY
//                                               network. Kept as a real call
//                                               that surfaces the upstream
//                                               refusal rather than a fake.

import { httpJson } from "../http.mjs";

export const COW_API = "https://api.cow.fi";

/** CoW network path segments keyed by chain id (verified: all return 200 on /version). */
export const COW_NETWORKS = Object.freeze({
  1: "mainnet",
  100: "xdai",
  42161: "arbitrum_one",
  8453: "base",
  11155111: "sepolia",
});

function base(opts = {}) {
  return (opts.baseUrl || process.env.COW_API_URL || COW_API).replace(/\/$/, "");
}

function network(args = {}) {
  if (args.network) return String(args.network);
  const chainId = Number(args.chainId ?? 1);
  const net = COW_NETWORKS[chainId];
  if (!net) {
    throw new Error(`cow-protocol: unsupported chainId ${chainId} (have: ${Object.keys(COW_NETWORKS).join(", ")})`);
  }
  return net;
}

function url(args, path, opts) {
  return `${base(opts)}/${network(args)}/api/v1${path}`;
}

function address(value, label) {
  const text = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`cow-protocol: ${label} must be an EVM address`);
  return text;
}

function limitOf(args, fallback = 10) {
  return Math.min(1000, Math.max(1, Number(args.limit ?? fallback)));
}

/**
 * Current batch auction (orders + native prices the solvers compete over).
 *
 * NOTE: the CoW CDN answers 403 to non-browser clients, so this throws with the
 * upstream status. That is the honest result — the alternative would be to
 * advertise data we cannot actually fetch.
 */
export async function cowAuction(args = {}, opts = {}) {
  return httpJson(url(args, "/auction", opts), {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}

/** Orders for one owner. CoW has no global open-order feed; owner is required. */
export async function cowOpenOrders(args = {}, opts = {}) {
  const owner = address(args.owner || args.address || args.user, "owner");
  const params = new URLSearchParams({ limit: String(limitOf(args)) });
  if (args.offset != null) params.set("offset", String(Math.max(0, Number(args.offset))));
  const orders = await httpJson(`${url(args, `/account/${owner}/orders`, opts)}?${params}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  const rows = Array.isArray(orders) ? orders : [];
  const open = args.openOnly === false
    ? rows
    : rows.filter((o) => String(o?.status || "").toLowerCase() === "open");
  return { owner, count: open.length, total: rows.length, orders: open };
}

/** Settled trades. The API demands exactly one of owner or orderUid. */
export async function cowRecentTrades(args = {}, opts = {}) {
  const params = new URLSearchParams();
  if (args.orderUid) params.set("orderUid", String(args.orderUid));
  else params.set("owner", address(args.owner || args.address || args.user, "owner"));
  const trades = await httpJson(`${url(args, "/trades", opts)}?${params}`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  const rows = Array.isArray(trades) ? trades : [];
  return { count: rows.length, trades: rows.slice(0, limitOf(args)) };
}

export async function cowProtocolHealth(opts = {}) {
  const version = await httpJson(`${base(opts)}/mainnet/api/v1/version`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 12_000,
  });
  const text = typeof version === "string" ? version : JSON.stringify(version ?? "");
  return { ok: text.trim().length > 0, provider: "cow-protocol", version: text.trim() || null };
}
