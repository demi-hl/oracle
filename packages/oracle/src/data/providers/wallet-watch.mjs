// followWallet.mjs — read-only ERC20 transfer history for an EVM address.
// Node >=18 ESM. No dependencies. No keys, no signing.
//
// Strategy: eth_getLogs with the wallet pinned into the indexed topic slots
// (topic1=from, topic2=to). That keeps result sets tiny, so free-tier
// "too many results" caps never trigger. Endpoints are chosen for real
// archive depth; publicnode-style nodes are excluded (~128 block history).

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Verified working archive endpoints (keyless). Ordered by preference.
export const DEFAULT_ENDPOINTS = {
  1: [
    "https://mainnet.gateway.tenderly.co",
    "https://eth.drpc.org",
    "https://rpc.flashbots.net",
  ],
  8453: [
    "https://base.gateway.tenderly.co",
    "https://mainnet.base.org",
    "https://base.drpc.org",
  ],
  42161: [
    "https://arbitrum.gateway.tenderly.co",
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.drpc.org",
  ],
};

// Max blocks per eth_getLogs call. Sized to the tightest verified free cap
// (drpc/base.org enforce 10_000; Tenderly allows far more but 10k is safe
// everywhere and keeps failover between providers transparent).
export const DEFAULT_CHUNK = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toHex = (n) => "0x" + BigInt(n).toString(16);
const topicAddr = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const addrFromTopic = (t) => "0x" + t.slice(26).toLowerCase();

// Errors that mean "same request might work later" -> retry.
const TRANSIENT = /timeout|timed out|too many requests|rate.?limit|429|502|503|504|internal error|temporarily|aborted|fetch failed|ECONNRESET|socket hang up/i;
// Errors that mean "this range is too big" -> split, don't retry.
const TOO_BIG = /too many|exceeds|limited to|not supported on free plan|response too large|range must not exceed|narrow your filter/i;

class RpcError extends Error {
  constructor(msg, { transient = false, tooBig = false, http = 0 } = {}) {
    super(msg);
    this.transient = transient;
    this.tooBig = tooBig;
    this.http = http;
  }
}

async function rpcCall(url, method, params, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    text = await res.text();
  } catch (e) {
    throw new RpcError(`${method} network: ${e.message}`, { transient: true });
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML error pages from CDNs (521/504) land here.
    throw new RpcError(`${method} non-JSON http=${res.status}: ${text.slice(0, 80)}`, {
      transient: res.status >= 500 || res.status === 429,
      http: res.status,
    });
  }

  if (json.error) {
    const m = json.error.message || "rpc error";
    throw new RpcError(`${method} rpc: ${m}`, {
      transient: TRANSIENT.test(m),
      tooBig: TOO_BIG.test(m),
      http: res.status,
    });
  }
  if (res.status !== 200) {
    throw new RpcError(`${method} http=${res.status}: ${text.slice(0, 80)}`, {
      transient: res.status >= 500 || res.status === 429,
      http: res.status,
    });
  }
  return json.result;
}

// Try each endpoint; retry transient failures with exponential backoff + jitter.
async function withFailover(urls, method, params, { retries, timeoutMs, onWarn }) {
  let last;
  for (const url of urls) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return { result: await rpcCall(url, method, params, timeoutMs), url };
      } catch (e) {
        last = e;
        if (e.tooBig) throw e;               // caller must split the range
        if (!e.transient) break;             // permanent for this endpoint -> next endpoint
        if (attempt === retries) break;
        const backoff = Math.min(2000 * 2 ** attempt, 8000) + Math.random() * 250;
        onWarn?.(`retry ${url} (${e.message.slice(0, 70)}) in ${Math.round(backoff)}ms`);
        await sleep(backoff);
      }
    }
    onWarn?.(`endpoint exhausted: ${url} -> ${last?.message.slice(0, 70)}`);
  }
  throw last ?? new RpcError("no endpoints available");
}

// Fetch one window, halving recursively if the provider says it's too big.
async function fetchWindow(urls, filter, from, to, cfg, out) {
  let params = [{ ...filter, fromBlock: toHex(from), toBlock: toHex(to) }];
  try {
    const { result } = await withFailover(urls, "eth_getLogs", params, cfg);
    if (Array.isArray(result)) out.push(...result);
    return;
  } catch (e) {
    if (!e.tooBig || to <= from) throw e;
    cfg.onWarn?.(`splitting ${from}-${to} (${e.message.slice(0, 60)})`);
  }
  const mid = from + Math.floor((to - from) / 2);
  await fetchWindow(urls, filter, from, mid, cfg, out);
  await fetchWindow(urls, filter, mid + 1, to, cfg, out);
}

/**
 * Read recent ERC20 transfers involving `address`.
 *
 * @param {string} address              0x-prefixed wallet address
 * @param {object} [opts]
 * @param {number[]} [opts.chains]      chain ids, default [1, 8453, 42161]
 * @param {number}  [opts.lookback]     blocks back from head, default 100000
 * @param {number}  [opts.fromBlock]    explicit start (overrides lookback)
 * @param {number}  [opts.toBlock]      explicit end, default head
 * @param {number}  [opts.chunkSize]    blocks per request, default 10000
 * @param {string[]}[opts.tokens]       restrict to these token contracts
 * @param {"in"|"out"|"both"} [opts.direction] default "both"
 * @param {number}  [opts.retries]      retries per endpoint, default 3
 * @param {number}  [opts.timeoutMs]    per-request timeout, default 20000
 * @param {number}  [opts.concurrency]  parallel chunks per chain, default 4
 * @param {object}  [opts.endpoints]    { chainId: [urls] } override
 * @param {(s:string)=>void} [opts.onWarn]
 * @returns {Promise<{events:Array,errors:Array,ranges:object}>}
 */
export async function followWallet(address, opts = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) {
    throw new Error(`invalid address: ${address}`);
  }
  const {
    chains = [1, 8453, 42161],
    lookback = 100_000,
    fromBlock,
    toBlock,
    chunkSize = DEFAULT_CHUNK,
    tokens,
    direction = "both",
    retries = 3,
    timeoutMs = 20_000,
    concurrency = 4,
    endpoints = DEFAULT_ENDPOINTS,
    onWarn,
  } = opts;

  const cfg = { retries, timeoutMs, onWarn };
  const wallet = topicAddr(address);
  const events = [];
  const errors = [];
  const ranges = {};
  const seen = new Set(); // dedupe key: chainId|txHash|logIndex

  await Promise.all(
    chains.map(async (chainId) => {
      const urls = endpoints[chainId];
      if (!urls?.length) {
        errors.push({ chainId, stage: "config", error: "no endpoints configured" });
        return;
      }
      try {
        // 1. Resolve the block range.
        let head = toBlock;
        if (head == null) {
          const { result } = await withFailover(urls, "eth_blockNumber", [], cfg);
          head = parseInt(result, 16);
        }
        const start = Math.max(0, fromBlock != null ? fromBlock : head - lookback + 1);
        const end = Math.max(start, head);
        ranges[chainId] = { fromBlock: start, toBlock: end, blocks: end - start + 1 };

        // 2. Build chunk list.
        const chunks = [];
        for (let b = start; b <= end; b += chunkSize) {
          chunks.push([b, Math.min(b + chunkSize - 1, end)]);
        }

        // 3. Topic filters — wallet pinned in indexed slots so results stay small.
        const filters = [];
        const base = tokens?.length ? { address: tokens } : {};
        if (direction === "in" || direction === "both") {
          filters.push({ ...base, topics: [TRANSFER_TOPIC, null, wallet] });
        }
        if (direction === "out" || direction === "both") {
          filters.push({ ...base, topics: [TRANSFER_TOPIC, wallet, null] });
        }

        // 4. Run chunks with bounded concurrency.
        const jobs = [];
        for (const f of filters) for (const c of chunks) jobs.push([f, c]);

        const raw = [];
        let cursor = 0;
        const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
          while (cursor < jobs.length) {
            const [filter, [lo, hi]] = jobs[cursor++];
            try {
              await fetchWindow(urls, filter, lo, hi, cfg, raw);
            } catch (e) {
              errors.push({ chainId, stage: "getLogs", range: [lo, hi], error: e.message });
            }
          }
        });
        await Promise.all(workers);

        // 5. Normalize + dedupe.
        for (const log of raw) {
          if (!log?.topics || log.topics.length < 3) continue;      // skip ERC721 (4 topics) / malformed
          const logIndex = parseInt(log.logIndex, 16);
          const key = `${chainId}|${log.transactionHash}|${logIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          events.push({
            chainId,
            token: log.address.toLowerCase(),
            from: addrFromTopic(log.topics[1]),
            to: addrFromTopic(log.topics[2]),
            value: BigInt(log.data === "0x" ? "0x0" : log.data).toString(),
            blockNumber: parseInt(log.blockNumber, 16),
            txHash: log.transactionHash,
            logIndex,
          });
        }
      } catch (e) {
        errors.push({ chainId, stage: "range", error: e.message });
      }
    })
  );

  events.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  return { events, errors, ranges };
}

export default followWallet;
