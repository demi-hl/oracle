// Generic EVM scanner.
//
// This is the payoff of the contract: a chain becomes a CONFIG entry rather than a
// bespoke integration. Everything here works on any EVM chain that exposes standard
// JSON-RPC -- balances, ERC-20 metadata, log scanning, and pool discovery via the
// public market-data providers.
//
// What it deliberately does NOT do: sign, broadcast, or invent a venue. Routing and
// quoting need chain-specific verified addresses, so a chain supplies those in its
// config and anything absent stays fail-closed.

import { rpcCall, rpcBlockNumber, rpcGetBalance, erc20BalanceOf } from "../data/providers/evm-rpc.mjs";
import { dexscreenerToken } from "../data/providers/dexscreener.mjs";
import { EVIDENCE, RISK } from "./contract.mjs";
import { v2VenueCapabilities } from "./v2-venue.mjs";
import { v3VenueCapabilities } from "./v3-venue.mjs";

// --- minimal ABI encoding, so the scanner has no ABI-library dependency -------

const SELECTORS = {
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  totalSupply: "0x18160ddd",
  owner: "0x8da5cb5b",
};

function hexToBigInt(hex) {
  if (!hex || hex === "0x") return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

/**
 * Decode a Solidity `string` return value.
 *
 * Handles both the ABI-encoded dynamic string and the legacy bytes32 form that some
 * older tokens still return. Getting this wrong shows the user mojibake instead of a
 * symbol, which erodes trust in every other number on the screen.
 */
function decodeString(hex) {
  if (!hex || hex === "0x") return null;
  const body = hex.slice(2);

  // Dynamic string: offset(32) + length(32) + data
  if (body.length >= 128) {
    const len = Number(BigInt(`0x${body.slice(64, 128)}`));
    if (len > 0 && len <= 256 && body.length >= 128 + len * 2) {
      const bytes = body.slice(128, 128 + len * 2);
      const s = Buffer.from(bytes, "hex").toString("utf8").replace(/\0+$/, "");
      if (s) return s;
    }
  }

  // bytes32: right-padded with zeros
  const trimmed = Buffer.from(body.slice(0, 64), "hex")
    .toString("utf8")
    .replace(/\0+$/, "");
  return trimmed || null;
}

function padAddress(addr) {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

// --- capability implementations ----------------------------------------------

function makeCapabilities(config) {
  const { chainId } = config;

  async function call(to, data, opts) {
    return rpcCall(chainId, "eth_call", [{ to, data }, "latest"], opts);
  }

  return {
    async blockNumber(opts = {}) {
      const n = await rpcBlockNumber(chainId, opts);
      return { chainId, blockNumber: n?.blockNumber ?? n, evidence: EVIDENCE.LIVE };
    },

    async nativeBalance(address, opts = {}) {
      const r = await rpcGetBalance(chainId, address, opts);
      return {
        chainId,
        address,
        wei: r?.wei ?? r?.balance ?? null,
        symbol: config.nativeCurrency?.symbol ?? null,
        decimals: config.nativeCurrency?.decimals ?? 18,
        evidence: EVIDENCE.LIVE,
      };
    },

    async tokenBalance({ token, owner }, opts = {}) {
      const r = await erc20BalanceOf({ chainId, token, owner }, opts);
      return { chainId, token, owner, raw: r?.balance ?? r, evidence: EVIDENCE.LIVE };
    },

    /**
     * Resolve an ERC-20's on-chain identity.
     *
     * Reads metadata from the contract itself rather than a token list, because a
     * token list can be stale or omit a two-hour-old launch -- and because the
     * on-chain answer is the one that governs an actual transfer.
     */
    async resolveToken(token, opts = {}) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(token || "")) {
        return {
          chainId,
          token,
          evidence: EVIDENCE.UNKNOWN,
          error: "resolveToken needs a 20-byte address; symbol lookup is a market-data concern",
        };
      }

      const [dec, sym, nm, supply] = await Promise.all([
        call(token, SELECTORS.decimals, opts).catch(() => null),
        call(token, SELECTORS.symbol, opts).catch(() => null),
        call(token, SELECTORS.name, opts).catch(() => null),
        call(token, SELECTORS.totalSupply, opts).catch(() => null),
      ]);

      const decimals = hexToBigInt(dec?.result ?? dec);
      const isContract = decimals !== null || sym?.result || nm?.result;

      return {
        chainId,
        address: token,
        decimals: decimals === null ? null : Number(decimals),
        symbol: decodeString(sym?.result ?? sym),
        name: decodeString(nm?.result ?? nm),
        totalSupply: (hexToBigInt(supply?.result ?? supply) ?? null)?.toString() ?? null,
        // A "token" that answers none of the standard calls is not an ERC-20.
        evidence: isContract ? EVIDENCE.LIVE : EVIDENCE.UNKNOWN,
        warning: isContract
          ? undefined
          : "no ERC-20 metadata returned -- may not be a token contract",
      };
    },

    /**
     * Find tradeable pools via public market data.
     *
     * Deliberately routed through DexScreener rather than a factory walk: a factory
     * walk finds pools that EXIST, while what a trader needs is pools with real
     * liquidity. Pools with no liquidity are noise that gets people filled badly.
     */
    async resolvePools(token, opts = {}) {
      const slug = config.dexscreenerSlug;
      if (!slug) {
        return {
          chainId,
          token,
          pools: [],
          evidence: EVIDENCE.UNAVAILABLE,
          reason:
            "no dexscreenerSlug configured for this chain; pool discovery is unavailable rather than guessed",
        };
      }

      const res = await dexscreenerToken(token, opts).catch(() => null);
      const pairs = (res?.pairs || res?.data?.pairs || []).filter(
        (p) => String(p.chainId).toLowerCase() === String(slug).toLowerCase(),
      );

      const pools = pairs
        .map((p) => ({
          pair: p.pairAddress,
          dex: p.dexId,
          base: p.baseToken?.address,
          quote: p.quoteToken?.address,
          liquidityUsd: p.liquidity?.usd ?? null,
          priceUsd: p.priceUsd ?? null,
          volume24hUsd: p.volume?.h24 ?? null,
          createdAt: p.pairCreatedAt ?? null,
        }))
        .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

      return {
        chainId,
        token,
        pools,
        evidence: pools.length ? EVIDENCE.LIVE : EVIDENCE.UNKNOWN,
      };
    },

    /**
     * Scan a block range for logs.
     *
     * Chunked, because every public RPC caps range width and an unchunked scan fails
     * confusingly at the provider rather than here.
     */
    async scanBlocks({ fromBlock, toBlock, address, topics, chunkSize = 2000 } = {}, opts = {}) {
      if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock)) {
        throw new Error("scanBlocks requires integer fromBlock and toBlock");
      }
      if (toBlock < fromBlock) throw new Error("toBlock must be >= fromBlock");

      const logs = [];
      const chunks = [];
      for (let start = fromBlock; start <= toBlock; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, toBlock);
        chunks.push([start, end]);
      }

      for (const [start, end] of chunks) {
        const filter = {
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
        };
        if (address) filter.address = address;
        if (topics) filter.topics = topics;

        const res = await rpcCall(chainId, "eth_getLogs", [filter], opts).catch((e) => ({
          error: String(e?.message || e),
        }));
        if (res?.error) {
          // Report the partial scan honestly instead of pretending the range was clean.
          return {
            chainId,
            fromBlock,
            toBlock,
            logs,
            complete: false,
            failedAt: [start, end],
            error: res.error,
            evidence: EVIDENCE.UNKNOWN,
          };
        }
        for (const l of res?.result ?? res ?? []) logs.push(l);
      }

      return {
        chainId,
        fromBlock,
        toBlock,
        logs,
        complete: true,
        chunks: chunks.length,
        evidence: EVIDENCE.LIVE,
      };
    },

    /**
     * Structural risk assessment.
     *
     * Returns UNKNOWN rather than PASS when checks could not run -- the distinction
     * that keeps "we couldn't tell" from reading as "it's fine".
     */
    async scoreRisk(token, opts = {}) {
      const checks = [];
      let verdict = RISK.PASS;

      const downgrade = (v) => {
        const order = { [RISK.PASS]: 0, [RISK.CAUTION]: 1, [RISK.UNKNOWN]: 2, [RISK.FAIL]: 3 };
        if (order[v] > order[verdict]) verdict = v;
      };

      const meta = await this.resolveToken(token, opts);
      if (meta.evidence !== EVIDENCE.LIVE) {
        checks.push({ check: "erc20-metadata", result: RISK.UNKNOWN, detail: meta.warning });
        downgrade(RISK.UNKNOWN);
      } else {
        checks.push({ check: "erc20-metadata", result: RISK.PASS, detail: `${meta.symbol} / ${meta.decimals}d` });
      }

      const pools = await this.resolvePools(token, opts);
      if (pools.evidence === EVIDENCE.UNAVAILABLE) {
        checks.push({ check: "liquidity", result: RISK.UNKNOWN, detail: pools.reason });
        downgrade(RISK.UNKNOWN);
      } else if (!pools.pools.length) {
        checks.push({ check: "liquidity", result: RISK.FAIL, detail: "no pool with liquidity found" });
        downgrade(RISK.FAIL);
      } else {
        const top = pools.pools[0];
        const liq = top.liquidityUsd ?? 0;
        if (liq < 5_000) {
          checks.push({ check: "liquidity", result: RISK.CAUTION, detail: `top pool only $${liq}` });
          downgrade(RISK.CAUTION);
        } else {
          checks.push({ check: "liquidity", result: RISK.PASS, detail: `$${liq} on ${top.dex}` });
        }

        if (top.createdAt && Date.now() - top.createdAt < 24 * 3600 * 1000) {
          checks.push({ check: "age", result: RISK.CAUTION, detail: "pool under 24h old" });
          downgrade(RISK.CAUTION);
        }
      }

      // Sellability. This is the check that actually separates a tradeable token
      // from a trap, so run it for real when the chain has a verified router and say
      // plainly that it is unproven when it does not.
      if (typeof this.sellSimulation === "function") {
        const sim = await this.sellSimulation(
          { token, amountIn: (10n ** 16n).toString() },
          opts,
        ).catch((e) => ({ verdict: RISK.UNKNOWN, reason: String(e?.message || e) }));

        checks.push({
          check: "sellability",
          result: sim.verdict,
          detail:
            sim.retentionBps != null
              ? `round trip returns ${(sim.retentionBps / 100).toFixed(2)}% -- ${sim.reason}`
              : sim.reason,
        });
        downgrade(sim.verdict);
      } else {
        checks.push({
          check: "sellability",
          result: RISK.UNKNOWN,
          detail:
            "no verified router on this chain, so a round-trip sell simulation cannot " +
            "run. Treat as unproven -- a buy path is not an exit path.",
        });
        downgrade(RISK.UNKNOWN);
      }

      return {
        chainId,
        token,
        verdict,
        checks,
        note:
          "Structural checks only. UNKNOWN is not PASS. A token is not tradeable " +
          "until a sell simulation succeeds.",
      };
    },
  };
}

/**
 * Build a scanner definition for any EVM chain from config alone.
 *
 * @param {object} config
 * @param {string} config.key                 lowercase slug
 * @param {number} config.chainId
 * @param {string} config.name
 * @param {string[]} config.rpcEnv            env var names holding the RPC url
 * @param {object} [config.nativeCurrency]    { symbol, decimals }
 * @param {string} [config.explorer]
 * @param {string} [config.dexscreenerSlug]   enables pool discovery
 * @param {object[]} [config.venues]          verified routers/quoters/factories
 */
export function defineEvmScanner(config) {
  const caps = makeCapabilities(config);

  // Single object holding BOTH generic and venue capabilities, so every capability
  // sees the others through `this`. This matters for scoreRisk: it calls
  // this.sellSimulation, which only exists once venue caps are merged in. Binding
  // generic caps to their own object first would leave scoreRisk permanently blind to
  // the real sell check and silently report sellability as UNKNOWN on a chain that
  // can actually prove it.
  const surface = { ...caps };

  // Venue adapters are selected by declared shape. V3 cannot reuse the V2 adapter --
  // it has no getAmountsOut, prices through a separate Quoter, and needs an explicit
  // fee tier -- so encoding one with the other's assumptions yields a transaction
  // that reverts or routes through the wrong pool.
  const kinds = new Set((config.venues || []).map((v) => v.kind));
  if (config.venueKind === "uniswap-v3" && kinds.has("quoter") && kinds.has("router")) {
    Object.assign(
      surface,
      v3VenueCapabilities({
        chainId: config.chainId,
        wrappedNative: config.wrappedNative,
      }),
    );
  } else if (config.venueKind === "uniswap-v2" && kinds.has("router")) {
    Object.assign(
      surface,
      v2VenueCapabilities({
        chainId: config.chainId,
        wrappedNative: config.wrappedNative,
      }),
    );
  }

  const bound = {};
  for (const [k, fn] of Object.entries(surface)) bound[k] = fn.bind(surface);

  return {
    key: config.key,
    chainId: config.chainId,
    name: config.name,
    rpcEnv: config.rpcEnv,
    nativeCurrency: config.nativeCurrency,
    explorer: config.explorer,
    venues: config.venues || [],
    capabilities: bound,
  };
}
