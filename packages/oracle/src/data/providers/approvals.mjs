// Token approval review — read-only allowance + operator discovery over public RPC.
//
// Hard boundaries:
//   - READ ONLY. eth_getLogs + eth_call (allowance/isApprovedForAll/metadata).
//   - Never signs, never broadcasts, never touches key material.
//   - Discovery is log-derived, so it is scoped to a block range and is
//     explicitly NOT a proof of completeness. An empty result means "nothing
//     found in the scanned range", never "this wallet is safe".
//
// Two approval shapes are covered, because they drain differently:
//   - ERC-20 `allowance(owner, spender)` — a spender may move up to N tokens.
//   - ERC-721/1155 `isApprovedForAll(owner, operator)` — an operator may move
//     EVERY NFT in the collection, with no cap. This is the shape behind most
//     real-world NFT drains, so omitting it while titling the surface "what can
//     spend your tokens" would overpromise.

import { Interface, getAddress, id as keccakId } from "ethers";
import { CHAIN_CONFIGS } from "../../scanner/chains.config.mjs";
import { mapLimit } from "../http.mjs";
import { rpcCall, rpcBlockNumber, erc20Allowance } from "./evm-rpc.mjs";

const ERC20_META = new Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const ERC721_OPERATOR = new Interface([
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function name() view returns (string)",
]);

/** keccak256("Approval(address,address,uint256)") */
const APPROVAL_TOPIC = keccakId("Approval(address,address,uint256)");
/** keccak256("ApprovalForAll(address,address,bool)") */
const APPROVAL_FOR_ALL_TOPIC = keccakId("ApprovalForAll(address,address,bool)");

/**
 * Blocks scanned back from head.
 *
 * Public RPCs cap `eth_getLogs` ranges hard and inconsistently (Polygon's
 * public node refuses anything over 10k). The default sits at that common
 * ceiling so a scan degrades to "found nothing recent" rather than failing
 * outright, and callers who run their own archive node can widen it.
 */
const DEFAULT_LOOKBACK_BLOCKS = 10_000;
const MAX_LOOKBACK_BLOCKS = 200_000;

/**
 * Well-known spenders. Labeling is best-effort and additive only: an unlabeled
 * spender is reported as unknown rather than guessed at, because a wrong
 * protocol name on a malicious spender is worse than no name.
 */
const KNOWN_SPENDERS = Object.freeze({
  "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch v5 Router",
  "0x111111125421ca6dc452d289314280a0f8842a65": "1inch v6 Router",
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap Universal Router",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Universal Router",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
  "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap v3 Router",
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "Uniswap v2 Router",
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": "0x Exchange Proxy",
  "0x2626664c2603336e57b271c5c0b26f421741e481": "Uniswap SwapRouter02 (Base)",
  "0x6131b5fae19ea4f9d964eac0408e4408b66337b5": "KyberSwap Meta Aggregator",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC (token contract)",
});

/**
 * Candidate spenders probed directly when log discovery is unavailable.
 *
 * Public RPC endpoints refuse unfiltered `eth_getLogs`, so log-derived
 * discovery cannot be the primary path. Probing a curated router set with
 * `allowance()` is a plain `eth_call`, works on every public endpoint, and
 * returns live truth rather than historical intent. It trades completeness for
 * actually functioning: it can only find approvals to spenders on this list,
 * which is why the response reports its own method and scope.
 */
const CANDIDATE_SPENDERS = Object.freeze([
  { address: "0x000000000022d473030f116ddee9f6b43ac78ba3", label: "Permit2" },
  { address: "0x1111111254eeb25477b68fb85ed929f73a960582", label: "1inch v5 Router" },
  { address: "0x111111125421ca6dc452d289314280a0f8842a65", label: "1inch v6 Router" },
  { address: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", label: "Uniswap Universal Router" },
  { address: "0xe592427a0aece92de3edee1f18e0157c05861564", label: "Uniswap v3 Router" },
  { address: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d", label: "Uniswap v2 Router" },
  { address: "0xdef1c0ded9bec7f1a1670819833240f027b25eff", label: "0x Exchange Proxy" },
  { address: "0x2626664c2603336e57b271c5c0b26f421741e481", label: "Uniswap SwapRouter02" },
]);

/**
 * Marketplaces and operators worth probing for blanket NFT approval.
 *
 * `setApprovalForAll` grants control over an entire collection, so a single
 * stale grant to a compromised or malicious operator can drain every NFT in it.
 * These are the operators a normal wallet actually grants, plus the shared
 * transfer helpers that phishing sites imitate.
 */
const CANDIDATE_OPERATORS = Object.freeze([
  { address: "0x1e0049783f008a0085193e00003d00cd54003c71", label: "OpenSea Seaport Conduit" },
  { address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", label: "Seaport 1.5" },
  { address: "0x0000000000000068f116a894984e2db1123eb395", label: "Seaport 1.6" },
  { address: "0x00000000000001ad428e4906ae43d8f9852d0dd6", label: "Seaport 1.4" },
  { address: "0x000000000000ad05ccc4f10045630fb830b95127", label: "Blur Marketplace" },
  { address: "0x00000000000000000000000000000000000000a5", label: "Blur Execution Delegate" },
  { address: "0xf42aa99f011a1fa7cda90e5e98b277e306bca83e", label: "Rarible Transfer Proxy" },
  { address: "0x000000000022d473030f116ddee9f6b43ac78ba3", label: "Permit2" },
]);

/**
 * Per-chain NFT collections worth probing for blanket operator approval.
 *
 * Mainnet only for now: every entry must be a verified collection address, and
 * an unverified guess is worse than an absent one because it would silently
 * report "nothing found" for a contract that does not exist.
 */
const CANDIDATE_COLLECTIONS = Object.freeze({
  1: [
    { address: "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d", name: "Bored Ape Yacht Club" },
    { address: "0x60e4d786628fea6478f785a6d7e704777c86a7c6", name: "Mutant Ape Yacht Club" },
    { address: "0xed5af388653567af2f388e6224dc7c4b3241c544", name: "Azuki" },
    { address: "0x8a90cab2b38dba80c64b7734e58ee1db38b8992e", name: "Doodles" },
    { address: "0x49cf6f5d44e70224e2e23fdcdd2c053f30ada28b", name: "CloneX" },
    { address: "0x23581767a106ae21c074b2276d25e5c3e136a68b", name: "Moonbirds" },
  ],
});

/** Per-chain tokens worth probing. Stablecoins and majors carry the risk. */
const CANDIDATE_TOKENS = Object.freeze({
  1: [
    { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
    { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 },
    { address: "0x6b175474e89094c44da98b954eedeac495271d0f", symbol: "DAI", decimals: 18 },
    { address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH", decimals: 18 },
    { address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", symbol: "WBTC", decimals: 8 },
  ],
  8453: [
    { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 },
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  ],
  42161: [
    { address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", symbol: "USDC", decimals: 6 },
    { address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", symbol: "USDT", decimals: 6 },
    { address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", symbol: "WETH", decimals: 18 },
  ],
  10: [
    { address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", symbol: "USDC", decimals: 6 },
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  ],
  137: [
    { address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", symbol: "USDC", decimals: 6 },
    { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", symbol: "USDT", decimals: 6 },
  ],
});

const UINT256_MAX = (1n << 256n) - 1n;
/**
 * Kept numerically identical to `ORACLE_UNLIMITED_FLOOR` / `ORACLE_STALE_AFTER_MS`
 * in @oracle-agent/contract, but deliberately NOT imported: this package is
 * published to npm and must not gain a dependency edge on the contract package.
 * `approvals-contract-parity.test.mjs` fails if the two ever drift.
 */
const UNLIMITED_FLOOR = UINT256_MAX / 2n;
const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Caches. Every entry is derived from public reads, so nothing here is
 * sensitive — but this provider sits behind a public route, so each cache is
 * bounded and evicted oldest-first rather than allowed to grow with traffic.
 *
 * Caching is skipped entirely when the caller injects `fetchImpl`. An injected
 * transport means the caller owns the data source (tests, replay harnesses),
 * and silently serving a previous transport's answer would be wrong.
 */
const META_TTL_MS = 6 * 60 * 60 * 1000;
const LOG_CAPABILITY_TTL_MS = 10 * 60 * 1000;
const SCAN_TTL_MS = 45 * 1000;
const MAX_META_ENTRIES = 512;
const MAX_SCAN_ENTRIES = 128;

const metaCache = new Map();
const logCapability = new Map();
const scanCache = new Map();

/** Drop every cached read. Exported for tests and for an operator-forced reload. */
export function clearApprovalsCache() {
  metaCache.clear();
  logCapability.clear();
  scanCache.clear();
}

/**
 * Cross-scan caches are skipped when the caller injects `fetchImpl`: an
 * injected transport means the caller owns the data source, and serving a
 * previous transport's answer would be wrong. `opts.cache: true` opts back in
 * so the caching itself can be exercised against a stub.
 */
function cacheable(opts) {
  if (opts?.cache === false) return false;
  return !opts?.fetchImpl || opts.cache === true;
}

function cacheGet(store, key, ttlMs) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ttlMs) {
    store.delete(key);
    return null;
  }
  return entry;
}

function cacheSet(store, key, value, maxEntries) {
  store.delete(key);
  store.set(key, { at: Date.now(), value });
  while (store.size > maxEntries) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

function normalizeAddress(value, label) {
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new Error(`${label} must be a valid EVM address`);
  }
}

function addressTopic(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function topicToAddress(topic) {
  return `0x${String(topic).slice(-40).toLowerCase()}`;
}

function riskFor({ unlimited, spenderLabel, lastActivityAt }) {
  if (unlimited) return "unlimited";
  if (!spenderLabel) return "unknown-spender";
  if (lastActivityAt) {
    const seen = Date.parse(lastActivityAt);
    if (Number.isFinite(seen) && Date.now() - seen > STALE_AFTER_MS) return "stale";
  }
  return "scoped";
}

function formatAllowance(raw, decimals, unlimited) {
  if (unlimited) return "UNLIMITED";
  if (decimals == null) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = raw % base;
  if (fraction === 0n) return whole.toLocaleString("en-US");
  const padded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  return `${whole.toLocaleString("en-US")}${padded ? `.${padded}` : ""}`;
}

/**
 * Read a token's decimals + symbol.
 *
 * Two layers, because a wallet that approved one token to eight spenders would
 * otherwise pay for the same immutable metadata eight times:
 *   - `memo` dedupes within a single scan, including concurrent in-flight reads
 *   - `metaCache` reuses across scans (decimals and symbol do not change)
 */
async function tokenMetadata(chainId, token, opts, memo) {
  const key = `${chainId}:${token}`;
  const pending = memo?.get(key);
  if (pending) return pending;
  if (cacheable(opts)) {
    const hit = cacheGet(metaCache, key, META_TTL_MS);
    if (hit) return hit.value;
  }

  const load = (async () => {
    const read = async (fn) => {
      try {
        const data = ERC20_META.encodeFunctionData(fn, []);
        const result = await rpcCall(chainId, "eth_call", [{ to: token, data }, "latest"], opts);
        if (!result || result === "0x") return null;
        return ERC20_META.decodeFunctionResult(fn, result)[0];
      } catch {
        return null;
      }
    };
    const [decimals, symbol] = await Promise.all([read("decimals"), read("symbol")]);
    const value = {
      decimals: decimals == null ? null : Number(decimals),
      symbol: symbol == null ? null : String(symbol).slice(0, 24),
    };
    if (cacheable(opts)) cacheSet(metaCache, key, value, MAX_META_ENTRIES);
    return value;
  })();

  memo?.set(key, load);
  return load;
}

/**
 * Discover candidate (token, spender) pairs from Approval logs.
 *
 * Opportunistic only. Public endpoints commonly refuse this call, so a failure
 * here is not an error: the caller falls back to direct probing.
 */
async function pairsFromLogs(chainId, owner, opts) {
  const lookback = Math.min(
    Math.max(Number(opts.lookbackBlocks) || DEFAULT_LOOKBACK_BLOCKS, 1),
    MAX_LOOKBACK_BLOCKS,
  );
  const head = await rpcBlockNumber(chainId, opts);
  if (!Number.isFinite(head)) throw new Error("chain head unavailable");
  const fromBlock = Math.max(0, head - lookback);
  const logs = await rpcCall(
    chainId,
    "eth_getLogs",
    [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: "latest",
      topics: [APPROVAL_TOPIC, addressTopic(owner)],
    }],
    opts,
  );
  if (!Array.isArray(logs)) throw new Error("log scan returned no array");

  const pairs = new Map();
  for (const log of logs) {
    const token = String(log?.address || "").toLowerCase();
    const spenderTopic = log?.topics?.[2];
    if (!token || !spenderTopic) continue;
    pairs.set(`${token}:${topicToAddress(spenderTopic)}`, {
      token,
      spender: topicToAddress(spenderTopic),
    });
  }
  return { pairs: [...pairs.values()], fromBlock, toBlock: head };
}

/** Curated (token, spender) pairs for the direct-probe path. */
function candidatePairs(chainId) {
  const tokens = CANDIDATE_TOKENS[chainId] || [];
  return tokens.flatMap((token) =>
    CANDIDATE_SPENDERS.map((spender) => ({
      token: token.address,
      spender: spender.address,
      symbol: token.symbol,
      decimals: token.decimals,
    })),
  );
}

/**
 * Scan one chain for live allowances granted by `owner`.
 *
 * Whichever way pairs are discovered, liveness always comes from a fresh
 * `allowance()` call. Log state alone would report long-revoked approvals as
 * still active.
 */
async function scanChain(chainId, owner, opts = {}) {
  let pairs = [];
  let method = "direct-probe";
  let range = null;

  const candidates = candidatePairs(chainId);
  const collections = collectionPairs(chainId);
  // A chain the endpoint refuses logs on AND that has no candidate token or
  // collection set can produce nothing. Probing it costs two round-trips to
  // learn that, so skip it outright rather than paying for a guaranteed empty
  // answer.
  const logsKnownRefused = cacheable(opts)
    && cacheGet(logCapability, chainId, LOG_CAPABILITY_TTL_MS)?.value === false;
  if (candidates.length === 0 && collections.length === 0 && logsKnownRefused) {
    return {
      scan: {
        chainId,
        status: "unconfigured",
        method,
        error: "no Approval log access and no candidate token or collection set for this chain",
      },
      approvals: [],
    };
  }

  try {
    const discovered = await pairsFromLogs(chainId, owner, opts);
    pairs = discovered.pairs;
    method = "log-scan";
    range = { fromBlock: discovered.fromBlock, toBlock: discovered.toBlock };
    if (cacheable(opts)) cacheSet(logCapability, chainId, true, 64);
  } catch {
    if (cacheable(opts)) cacheSet(logCapability, chainId, false, 64);
    pairs = candidates;
    if (pairs.length === 0 && collections.length === 0) {
      return {
        scan: {
          chainId,
          status: "unconfigured",
          method,
          error: "no Approval log access and no candidate token or collection set for this chain",
        },
        approvals: [],
      };
    }
  }

  try {
    const memo = new Map();
    const resolved = await mapLimit(pairs, opts.concurrency || 4, async (pair) => {
      try {
        const live = await erc20Allowance(
          { chainId, token: pair.token, owner, spender: pair.spender },
          opts,
        );
        const allowance = BigInt(live.allowance);
        if (allowance <= 0n) return null;
        const meta = pair.symbol
          ? { symbol: pair.symbol, decimals: pair.decimals ?? null }
          : await tokenMetadata(chainId, pair.token, opts, memo);
        const unlimited = allowance >= UNLIMITED_FLOOR;
        const spenderLabel = KNOWN_SPENDERS[pair.spender] || null;
        return {
          id: `${chainId}:${pair.token}:${pair.spender}`,
          chainId,
          standard: "erc20",
          token: pair.token,
          tokenSymbol: meta.symbol,
          decimals: meta.decimals,
          spender: pair.spender,
          spenderLabel,
          allowance: allowance.toString(),
          allowanceDisplay: formatAllowance(allowance, meta.decimals, unlimited),
          unlimited,
          lastActivityAt: null,
          risk: riskFor({ unlimited, spenderLabel, lastActivityAt: null }),
        };
      } catch {
        return null;
      }
    });

    const approvals = resolved.filter(Boolean);
    // Blanket NFT operator grants are a separate read on the same chain: a
    // plain eth_call that works even where log access is refused.
    const operators = await scanOperators(chainId, owner, opts);
    return {
      scan: {
        chainId,
        status: "ok",
        method,
        pairsProbed: pairs.length,
        collectionsProbed: collectionPairs(chainId).length,
        ...(range || {}),
      },
      approvals: [...approvals, ...operators],
    };
  } catch (error) {
    return {
      scan: {
        chainId,
        status: "unavailable",
        method,
        error: String(error?.message || error).slice(0, 200),
      },
      approvals: [],
    };
  }
}

/**
 * Read whether `operator` controls every NFT `owner` holds in `collection`.
 *
 * A plain `eth_call`, so it works on endpoints that refuse log queries. Returns
 * null when the contract does not answer, which keeps "not an NFT contract" and
 * "no approval" distinct instead of collapsing both to false.
 */
async function isApprovedForAll(chainId, collection, owner, operator, opts) {
  try {
    const data = ERC721_OPERATOR.encodeFunctionData("isApprovedForAll", [owner, operator]);
    const result = await rpcCall(chainId, "eth_call", [{ to: collection, data }, "latest"], opts);
    if (!result || result === "0x") return null;
    return Boolean(ERC721_OPERATOR.decodeFunctionResult("isApprovedForAll", result)[0]);
  } catch {
    return null;
  }
}

/** Curated (collection, operator) pairs for the NFT direct-probe path. */
function collectionPairs(chainId) {
  const collections = CANDIDATE_COLLECTIONS[chainId] || [];
  return collections.flatMap((collection) =>
    CANDIDATE_OPERATORS.map((operator) => ({
      collection: collection.address,
      collectionName: collection.name,
      operator: operator.address,
      operatorLabel: operator.label,
    })),
  );
}

/**
 * Discover blanket NFT operator grants.
 *
 * `setApprovalForAll` has no amount, so risk is binary and always maximal for
 * the collection: every token in it can be moved. These are reported with an
 * explicit `operator-all` risk rather than being folded into the ERC-20 scale,
 * where "unlimited" still means a single token's balance.
 */
async function scanOperators(chainId, owner, opts) {
  const pairs = collectionPairs(chainId);
  if (pairs.length === 0) return [];

  const resolved = await mapLimit(pairs, opts.concurrency || 4, async (pair) => {
    const approved = await isApprovedForAll(chainId, pair.collection, owner, pair.operator, opts);
    if (approved !== true) return null;
    return {
      id: `${chainId}:${pair.collection}:${pair.operator}:all`,
      chainId,
      standard: "erc721",
      token: pair.collection,
      tokenSymbol: pair.collectionName,
      decimals: null,
      spender: pair.operator,
      spenderLabel: pair.operatorLabel,
      allowance: null,
      allowanceDisplay: "ALL ITEMS",
      unlimited: true,
      lastActivityAt: null,
      risk: "operator-all",
    };
  });

  return resolved.filter(Boolean);
}

export async function approvalsHealth() {
  return {
    ok: true,
    provider: "approvals",
    readOnly: true,
    method: "eth_getLogs + eth_call allowance/isApprovedForAll",
  };
}

/**
 * Review live ERC-20 approvals for an owner across the requested EVM chains.
 * Returns only what was actually observed; unreachable chains are reported as
 * unavailable rather than silently dropped.
 */
export async function approvalsScan(args = {}, opts = {}) {
  const owner = normalizeAddress(args.owner || args.address, "owner");
  const configured = new Map(CHAIN_CONFIGS.map((chain) => [chain.chainId, chain]));
  const requested = Array.isArray(args.chainIds) && args.chainIds.length
    ? [...new Set(args.chainIds.map(Number))].filter((id) => configured.has(id))
    : [...configured.keys()];

  // Allowances change only when the owner signs a transaction, so a short TTL
  // collapses a polling UI's repeated scans without risking a stale answer.
  // `refresh: true` (an explicit user reload) always bypasses it.
  const cacheKey = `${owner}:${[...requested].sort((a, b) => a - b).join(",")}:${args.lookbackBlocks ?? ""}`;
  const useCache = cacheable(opts) && !args.refresh;
  if (useCache) {
    const hit = cacheGet(scanCache, cacheKey, SCAN_TTL_MS);
    if (hit) return { ...hit.value, cached: true, cachedAgeMs: Date.now() - hit.at };
  }

  const results = await mapLimit(requested, args.concurrency || 3, (chainId) =>
    scanChain(chainId, owner, { ...opts, lookbackBlocks: args.lookbackBlocks }),
  );

  const approvals = results.flatMap((entry) => entry.approvals);
  const scans = results.map((entry) => entry.scan);
  const logScan = scans.find((scan) => scan.method === "log-scan" && scan.toBlock);
  const probed = scans.some((scan) => scan.method === "direct-probe" && scan.status === "ok");

  const payload = {
    provider: "approvals",
    operation: "scan",
    readOnly: true,
    queriedAt: new Date().toISOString(),
    owner,
    scannedRange: logScan
      ? `last ${logScan.toBlock - logScan.fromBlock} blocks`
      : probed
        ? "known routers, live allowance probe"
        : null,
    approvals,
    scans,
    warnings: [
      "Approval discovery is scoped. Log scanning is used where the endpoint permits it; otherwise a curated router set is probed directly. An empty result means nothing was found in that scope, not that the wallet is safe.",
      "NFT operator approval (setApprovalForAll) is checked against a curated collection and marketplace set on supported chains only. A collection outside that set is not checked.",
    ],
  };

  if (useCache) cacheSet(scanCache, cacheKey, payload, MAX_SCAN_ENTRIES);
  return { ...payload, cached: false, cachedAgeMs: 0 };
}
