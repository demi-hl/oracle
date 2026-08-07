// Read-only multichain portfolio aggregation. No keys, signing, or broadcast.

import { getAddress } from "ethers";
import { CHAIN_CONFIGS } from "../../scanner/chains.config.mjs";
import { mapLimit, timed } from "../http.mjs";
import { rpcGetBalance } from "./evm-rpc.mjs";
import {
  SPL_TOKEN_PROGRAM_ID,
  solanaGetBalance,
  solanaTokenAccounts,
  solanaPubkey,
} from "./solana-rpc.mjs";
import { btcAddress, btcAddressInfo } from "./bitcoin-esplora.mjs";
import { btcInscriptions, btcRuneBalances } from "./bitcoin-meta.mjs";
import { hlAllMids, hlClearinghouse, hlUserState } from "./hl-info.mjs";
import { llamaPrices } from "./defillama.mjs";

export const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const PRICE_KEY_BY_SYMBOL = Object.freeze({
  ETH: "coingecko:ethereum",
  POL: "coingecko:polygon-ecosystem-token",
  BNB: "coingecko:binancecoin",
  AVAX: "coingecko:avalanche-2",
  HYPE: "coingecko:hyperliquid",
  USDT0: "coingecko:tether",
  SOL: "coingecko:solana",
  BTC: "coingecko:bitcoin",
});

function sharedOpts(opts = {}, key) {
  return {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    // Address resolution already honours a caller-supplied env, but RPC URL
    // resolution reads `opts.env` too (evm-rpc resolveRpcUrl defaults it to
    // process.env). Without threading it here, a caller that passes its own env
    // gets its addresses honoured and its endpoints ignored — the scan silently
    // falls back to public RPCs instead of the configured ones.
    env: opts.env,
    ...(opts[key] || {}),
  };
}

function envAddress(env, ...names) {
  for (const name of names) {
    const value = String(env?.[name] || "").trim();
    if (value) return value;
  }
  return null;
}

function normalizeEvmAddress(value) {
  if (!value) return null;
  try {
    return getAddress(String(value).trim().toLowerCase());
  } catch {
    throw new Error("portfolio: EVM address must be a valid 20-byte address");
  }
}

export function resolvePortfolioAddresses(args = {}, env = process.env) {
  const input = args.addresses || {};
  const evm = normalizeEvmAddress(
    input.evm ||
      args.evmAddress ||
      envAddress(env, "ORACLE_EVM_ADDRESS", "ORACLE_DEFAULT_ADDRESS", "MAD_OPERATOR_ADDRESS"),
  );
  const solanaRaw =
    input.solana || args.solanaAddress || envAddress(env, "ORACLE_SOLANA_ADDRESS");
  const bitcoinRaw =
    input.bitcoin || args.bitcoinAddress || envAddress(env, "ORACLE_BITCOIN_ADDRESS");
  const hyperliquid = normalizeEvmAddress(
    input.hyperliquid ||
      args.hyperliquidAddress ||
      envAddress(env, "ORACLE_HYPERLIQUID_ADDRESS") ||
      evm,
  );
  return {
    evm,
    solana: solanaRaw ? solanaPubkey(solanaRaw, "portfolio Solana address") : null,
    bitcoin: bitcoinRaw ? btcAddress(bitcoinRaw, "portfolio Bitcoin address") : null,
    hyperliquid,
  };
}

export function formatUnits(raw, decimals) {
  const value = BigInt(String(raw || "0"));
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 36) {
    throw new Error("portfolio: decimals must be an integer from 0 to 36");
  }
  if (places === 0) return value.toString();
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(places);
  const whole = abs / base;
  const fraction = String(abs % base).padStart(places, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function decimalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundedUsd(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function nonZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number !== 0;
}

function priceEntry(priceData, symbol) {
  const key = PRICE_KEY_BY_SYMBOL[symbol];
  const row = key ? priceData?.coins?.[key] : null;
  const priceUsd = Number(row?.price);
  return {
    key: key || null,
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
    timestamp: row?.timestamp ?? null,
    confidence: row?.confidence ?? null,
  };
}

function aggregateSolanaAccounts(results) {
  const byMint = new Map();
  for (const result of results) {
    if (!result?.ok) continue;
    for (const account of result.data?.accounts || []) {
      const raw = BigInt(String(account.amount || "0"));
      if (raw === 0n || !account.mint) continue;
      const key = `${account.mint}:${account.decimals ?? "unknown"}`;
      const current = byMint.get(key) || {
        mint: account.mint,
        amountRaw: 0n,
        decimals: account.decimals ?? null,
        programs: new Set(),
        accounts: 0,
      };
      current.amountRaw += raw;
      current.accounts += 1;
      if (result.program) current.programs.add(result.program);
      byMint.set(key, current);
    }
  }
  return [...byMint.values()].map((item) => {
    const amountRaw = item.amountRaw.toString();
    const amount = item.decimals == null ? null : formatUnits(amountRaw, item.decimals);
    const collectibleCandidate = item.decimals === 0 && item.amountRaw === 1n;
    return {
      mint: item.mint,
      amountRaw,
      amount,
      decimals: item.decimals,
      tokenPrograms: [...item.programs],
      accountCount: item.accounts,
      verification: "unverified",
      classification: collectibleCandidate ? "collectible-candidate" : "fungible-or-unclassified",
      priceUsd: null,
      usdValue: null,
    };
  });
}

function unavailableFamily(family, reason) {
  return { family, status: "unsupported", reason };
}

function decorateNative(native, priceData) {
  if (!native || native.status !== "ok") return native;
  const price = priceEntry(priceData, native.symbol);
  const amountNumber = decimalNumber(native.amount);
  const usdValue =
    amountNumber != null && price.priceUsd != null
      ? roundedUsd(amountNumber * price.priceUsd)
      : null;
  return { ...native, price, usdValue };
}

export async function portfolioHealth(opts = {}) {
  const addresses = resolvePortfolioAddresses({}, opts.env || process.env);
  return {
    ok: true,
    provider: "portfolio",
    readOnly: true,
    configuredFamilies: Object.entries(addresses)
      .filter(([, value]) => Boolean(value))
      .map(([family]) => family),
  };
}

export async function portfolioBalance(args = {}, opts = {}) {
  const queriedAt = new Date().toISOString();
  const addresses = resolvePortfolioAddresses(args, opts.env || process.env);
  const includePrices = args.includePrices !== false;
  const includeTokens = args.includeTokens !== false;
  const includeCollectibles = args.includeCollectibles !== false;
  const configuredChains = new Map(CHAIN_CONFIGS.map((chain) => [chain.chainId, chain]));
  const requestedIds = Array.isArray(args.evmChainIds) && args.evmChainIds.length
    ? [...new Set(args.evmChainIds.map(Number))]
    : [...configuredChains.keys()];

  const priceKeys = [...new Set(Object.values(PRICE_KEY_BY_SYMBOL))];
  const priceTask = includePrices
    ? timed(() => llamaPrices(priceKeys, sharedOpts(opts, "prices")))
    : Promise.resolve({ ok: false, ms: 0, error: "price lookup disabled" });

  const evmTask = mapLimit(requestedIds, args.concurrency || 5, async (chainId) => {
    const chain = configuredChains.get(chainId);
    if (!chain) {
      return {
        family: "evm",
        chainId,
        name: null,
        address: addresses.evm,
        status: "unsupported",
        error: "chainId is not in Oracle's configured EVM registry",
      };
    }
    if (!addresses.evm) {
      return {
        family: "evm",
        chainId,
        name: chain.name,
        address: null,
        status: "not-configured",
        error: "set ORACLE_EVM_ADDRESS or pass addresses.evm",
      };
    }
    const rpcOpts = {
      ...sharedOpts(opts, "evm"),
      rpcUrl: args.rpcUrls?.[chainId] || opts.evm?.rpcUrls?.[chainId],
    };
    const result = await timed(() => rpcGetBalance(chainId, addresses.evm, rpcOpts));
    if (!result.ok) {
      return {
        family: "evm",
        chainId,
        name: chain.name,
        address: addresses.evm,
        status: "unavailable",
        latencyMs: result.ms,
        error: result.error,
      };
    }
    const decimals = chain.nativeCurrency?.decimals ?? 18;
    const symbol = chain.nativeCurrency?.symbol || "NATIVE";
    const amountRaw = result.data.balanceWei;
    return {
      family: "evm",
      chainId,
      name: chain.name,
      address: addresses.evm,
      status: "ok",
      latencyMs: result.ms,
      native: {
        status: "ok",
        symbol,
        amountRaw,
        decimals,
        amount: formatUnits(amountRaw, decimals),
      },
      fungibleTokens: {
        status: includeTokens ? "unavailable" : "not-requested",
        assets: [],
        reason: includeTokens
          ? "EVM JSON-RPC cannot enumerate wallet tokens without an address indexer"
          : "token discovery disabled",
      },
      collectibles: {
        status: includeCollectibles ? "unavailable" : "not-requested",
        assets: [],
        reason: includeCollectibles
          ? "EVM JSON-RPC cannot enumerate wallet NFTs without an address indexer"
          : "collectible discovery disabled",
      },
      source: "evm-rpc",
    };
  });

  const solanaTask = (async () => {
    if (!addresses.solana) {
      return {
        family: "solana",
        name: "Solana Mainnet",
        address: null,
        status: "not-configured",
        error: "set ORACLE_SOLANA_ADDRESS or pass addresses.solana",
      };
    }
    const solOpts = sharedOpts(opts, "solana");
    const native = await timed(() => solanaGetBalance({ address: addresses.solana }, solOpts));
    const tokenReads = includeTokens || includeCollectibles
      ? await Promise.all([
          timed(() =>
            solanaTokenAccounts(
              { owner: addresses.solana, programId: SPL_TOKEN_PROGRAM_ID },
              solOpts,
            ),
          ).then((result) => ({ ...result, program: "spl-token" })),
          timed(() =>
            solanaTokenAccounts(
              { owner: addresses.solana, programId: SPL_TOKEN_2022_PROGRAM_ID },
              solOpts,
            ),
          ).then((result) => ({ ...result, program: "token-2022" })),
        ])
      : [];
    const assets = aggregateSolanaAccounts(tokenReads);
    const candidates = assets.filter((asset) => asset.classification === "collectible-candidate");
    const fungibles = assets.filter((asset) => asset.classification !== "collectible-candidate");
    const tokenErrors = tokenReads.filter((result) => !result.ok).map((result) => result.error);
    return {
      family: "solana",
      name: "Solana Mainnet",
      address: addresses.solana,
      status: native.ok || tokenReads.some((result) => result.ok) ? "ok" : "unavailable",
      native: native.ok
        ? {
            status: "ok",
            symbol: "SOL",
            amountRaw: native.data.lamports,
            decimals: 9,
            amount: formatUnits(native.data.lamports, 9),
            slot: native.data.slot,
          }
        : { status: "unavailable", symbol: "SOL", error: native.error },
      fungibleTokens: {
        status: !includeTokens
          ? "not-requested"
          : tokenErrors.length === tokenReads.length
            ? "unavailable"
            : tokenErrors.length
              ? "partial"
              : "ok",
        assets: includeTokens ? fungibles : [],
        errors: tokenErrors,
        note: "SPL accounts are unverified until a metadata/indexer source confirms symbol and spam status",
      },
      collectibles: {
        status: !includeCollectibles
          ? "not-requested"
          : tokenErrors.length === tokenReads.length
            ? "unavailable"
            : "partial",
        assets: includeCollectibles ? candidates : [],
        errors: tokenErrors,
        note: "decimals=0 and amount=1 is only a collectible candidate, not verified NFT metadata",
      },
      source: "solana-rpc",
    };
  })();

  const bitcoinTask = (async () => {
    if (!addresses.bitcoin) {
      return {
        family: "bitcoin",
        name: "Bitcoin Mainnet",
        address: null,
        status: "not-configured",
        error: "set ORACLE_BITCOIN_ADDRESS or pass addresses.bitcoin",
      };
    }
    const btcOpts = sharedOpts(opts, "bitcoin");
    const metaOpts = sharedOpts(opts, "bitcoinMeta");
    const [native, runes, inscriptions] = await Promise.all([
      timed(() => btcAddressInfo({ address: addresses.bitcoin }, btcOpts)),
      includeTokens
        ? timed(() => btcRuneBalances({ address: addresses.bitcoin }, metaOpts))
        : Promise.resolve({ ok: false, ms: 0, error: "token discovery disabled" }),
      includeCollectibles
        ? timed(() => btcInscriptions({ address: addresses.bitcoin }, metaOpts))
        : Promise.resolve({ ok: false, ms: 0, error: "collectible discovery disabled" }),
    ]);
    const runeData = runes.ok ? runes.data : null;
    const inscriptionData = inscriptions.ok ? inscriptions.data : null;
    return {
      family: "bitcoin",
      name: "Bitcoin Mainnet",
      address: addresses.bitcoin,
      status: native.ok || runeData?.ok || inscriptionData?.ok ? "ok" : "unavailable",
      native: native.ok
        ? {
            status: "ok",
            symbol: "BTC",
            amountRaw: native.data.balanceSats,
            decimals: 8,
            amount: formatUnits(native.data.balanceSats, 8),
          }
        : { status: "unavailable", symbol: "BTC", error: native.error },
      fungibleTokens: {
        status: !includeTokens
          ? "not-requested"
          : runeData?.ok
            ? "ok"
            : "unavailable",
        assets: runeData?.balances || [],
        error: runeData?.ok ? null : runeData?.error || runes.error,
        verification: "indexer-reported",
      },
      collectibles: {
        status: !includeCollectibles
          ? "not-requested"
          : inscriptionData?.ok
            ? "ok"
            : "unavailable",
        assets: inscriptionData?.inscriptions || [],
        error: inscriptionData?.ok ? null : inscriptionData?.error || inscriptions.error,
        unknownNotEmpty: Boolean(inscriptionData?.unknownNotEmpty),
        verification: "indexer-reported",
      },
      source: "bitcoin-esplora+bitcoin-meta",
    };
  })();

  const hyperliquidTask = (async () => {
    if (!addresses.hyperliquid) {
      return {
        family: "hyperliquid",
        name: "Hyperliquid HyperCore",
        address: null,
        status: "not-configured",
        error: "set ORACLE_HYPERLIQUID_ADDRESS or pass addresses.hyperliquid",
      };
    }
    const hlOpts = sharedOpts(opts, "hyperliquid");
    const [spot, perps, mids] = await Promise.all([
      timed(() => hlClearinghouse(addresses.hyperliquid, hlOpts)),
      timed(() => hlUserState(addresses.hyperliquid, hlOpts)),
      timed(() => hlAllMids(hlOpts)),
    ]);
    const spotBalances = (spot.ok && Array.isArray(spot.data?.balances) ? spot.data.balances : [])
      .filter((item) => nonZero(item.total) || nonZero(item.hold))
      .map((item) => ({
        coin: item.coin || null,
        total: String(item.total ?? "0"),
        hold: String(item.hold ?? "0"),
        priceUsd: null,
        usdValue: null,
      }));
    const positions = (perps.ok && Array.isArray(perps.data?.assetPositions)
      ? perps.data.assetPositions
      : [])
      .map((item) => item.position || item)
      .filter((item) => nonZero(item.szi))
      .map((item) => ({
        coin: item.coin || null,
        size: String(item.szi ?? "0"),
        entryPrice: item.entryPx ?? null,
        positionValueUsd: item.positionValue ?? null,
        unrealizedPnlUsd: item.unrealizedPnl ?? null,
        liquidationPrice: item.liquidationPx ?? null,
      }));
    return {
      family: "hyperliquid",
      name: "Hyperliquid HyperCore",
      address: addresses.hyperliquid,
      status: spot.ok || perps.ok ? "ok" : "unavailable",
      spot: {
        status: spot.ok ? "ok" : "unavailable",
        balances: spotBalances,
        error: spot.ok ? null : spot.error,
      },
      perps: {
        status: perps.ok ? "ok" : "unavailable",
        accountValueUsd: perps.data?.marginSummary?.accountValue ?? null,
        withdrawableUsd: perps.data?.withdrawable ?? null,
        positions,
        error: perps.ok ? null : perps.error,
      },
      mids: mids.ok ? mids.data : {},
      source: "hyperliquid-info",
    };
  })();

  const [evm, solana, bitcoin, hyperliquid, priceResult] = await Promise.all([
    evmTask,
    solanaTask,
    bitcoinTask,
    hyperliquidTask,
    priceTask,
  ]);
  const priceData = priceResult.ok ? priceResult.data : null;

  const decoratedEvm = evm.map((chain) =>
    chain.native ? { ...chain, native: decorateNative(chain.native, priceData) } : chain,
  );
  if (solana.native) solana.native = decorateNative(solana.native, priceData);
  if (bitcoin.native) bitcoin.native = decorateNative(bitcoin.native, priceData);

  let knownUsd = 0;
  let pricedItems = 0;
  let unpricedNonzeroItems = 0;
  for (const chain of [...decoratedEvm, solana, bitcoin]) {
    if (chain.native?.status !== "ok" || !nonZero(chain.native.amount)) continue;
    if (chain.native.usdValue != null) {
      knownUsd += chain.native.usdValue;
      pricedItems += 1;
    } else {
      unpricedNonzeroItems += 1;
    }
  }

  const hypePrice = priceEntry(priceData, "HYPE");
  for (const item of hyperliquid.spot?.balances || []) {
    const symbol = String(item.coin || "").toUpperCase();
    const priceUsd = symbol === "USDC" || symbol === "USDT" || symbol === "USDT0"
      ? 1
      : symbol === "HYPE"
        ? hypePrice.priceUsd || decimalNumber(hyperliquid.mids?.HYPE)
        : decimalNumber(hyperliquid.mids?.[item.coin]);
    const amount = decimalNumber(item.total);
    item.priceUsd = priceUsd;
    item.usdValue = amount != null && priceUsd != null ? roundedUsd(amount * priceUsd) : null;
    if (!nonZero(item.total)) continue;
    if (item.usdValue != null) {
      knownUsd += item.usdValue;
      pricedItems += 1;
    } else {
      unpricedNonzeroItems += 1;
    }
  }
  const perpsValue = decimalNumber(hyperliquid.perps?.accountValueUsd);
  if (perpsValue != null && perpsValue !== 0) {
    knownUsd += perpsValue;
    pricedItems += 1;
  }

  const solanaUnpriced = [
    ...(solana.fungibleTokens?.assets || []),
    ...(solana.collectibles?.assets || []),
  ].filter((asset) => nonZero(asset.amount)).length;
  const bitcoinUnpriced =
    (bitcoin.fungibleTokens?.assets || []).length +
    (bitcoin.collectibles?.assets || []).length;
  unpricedNonzeroItems += solanaUnpriced + bitcoinUnpriced;

  const allSurfaces = [...decoratedEvm, solana, bitcoin, hyperliquid];
  const count = (status) => allSurfaces.filter((surface) => surface.status === status).length;
  const warnings = [];
  if (decoratedEvm.some((chain) => chain.fungibleTokens?.status === "unavailable")) {
    warnings.push("EVM token and NFT discovery is unavailable without a configured address indexer; native balances are still live.");
  }
  if (solana.fungibleTokens?.assets?.length || solana.collectibles?.assets?.length) {
    warnings.push("Solana token accounts are unverified and may include spam; collectible candidates are not confirmed NFTs.");
  }
  if (bitcoin.collectibles?.unknownNotEmpty) {
    warnings.push("Bitcoin inscription holdings are unknown, not zero, because no address indexer is configured.");
  }
  if (!priceResult.ok) warnings.push(`Price provider unavailable: ${priceResult.error}`);

  const unsupportedFamilies = [
    unavailableFamily("cosmos", "requires a chain-specific bech32 address and LCD/RPC adapter"),
    unavailableFamily("sui", "Sui balance adapter is not installed"),
    unavailableFamily("aptos", "Aptos balance adapter is not installed"),
  ];

  const discoveryIncomplete = allSurfaces.some((surface) =>
    ["unavailable", "partial", "not-configured"].includes(surface.fungibleTokens?.status) ||
    ["unavailable", "partial", "not-configured"].includes(surface.collectibles?.status),
  );

  return {
    provider: "portfolio",
    operation: "balances",
    readOnly: true,
    queriedAt,
    addresses,
    coverage: {
      requestedSurfaces: allSurfaces.length,
      ok: count("ok"),
      unavailable: count("unavailable"),
      notConfigured: count("not-configured"),
      unsupported: count("unsupported") + unsupportedFamilies.length,
      evmChainsRequested: requestedIds.length,
      evmChainsOk: decoratedEvm.filter((chain) => chain.status === "ok").length,
    },
    valuation: {
      knownUsd: roundedUsd(knownUsd),
      label: "known priced value, not a complete portfolio total",
      pricedItems,
      unpricedNonzeroItems,
      complete:
        unpricedNonzeroItems === 0 &&
        !discoveryIncomplete &&
        count("unavailable") === 0 &&
        count("not-configured") === 0 &&
        unsupportedFamilies.length === 0,
      priceSource: includePrices ? "DefiLlama" : null,
      priceStatus: priceResult.ok ? "ok" : "unavailable",
      priceQueriedAt: queriedAt,
    },
    chains: [...decoratedEvm, solana, bitcoin, hyperliquid],
    unsupportedFamilies,
    warnings,
  };
}
