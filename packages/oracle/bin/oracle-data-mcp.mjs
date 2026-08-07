#!/usr/bin/env node
// Oracle data MCP — read-only multichain market/discovery plane.
// Loaded by an Oracle/Hermes profile. Never expose signing or broadcast here.
//
// Every tool is a READ or a prepared unsigned action. No key handling, signing,
// or broadcast. Routes to the Oracle data server read/prepare plane (/data/call),
// which is unauthenticated on loopback.
// This is the "scan all public APIs" surface: DeFiLlama protocol TVL, DexScreener
// token/search, LI.FI + Uniswap quotes, multi-chain RPC balances/blocks.
//
// Mirrors the Oracle exec MCP stdio JSON-RPC shape.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { env } from "../src/oracle-env.mjs";
import { listAddresses, lookupAddress, rememberAddress, forgetAddress } from "../src/address-book.mjs";

const DATA_URL = (env("ORACLE_DATA_URL", "MAD_DESK_URL", "http://127.0.0.1:8787")).replace(/\/$/, "");

const tools = [
  {
    name: "data_catalog",
    description:
      "List every read-plane provider the desk exposes (id, venue, chainIds, ops). Use this to discover what public APIs are available before calling data_call. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "data_health",
    description:
      "Health of every read-plane provider (which public APIs are up / configured). Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "data_call",
    description:
      "Generic escape hatch: call any provider/op from the catalog. provider+op are required; args is a free-form object matching that op. Read-only. Use data_catalog first to see valid provider/op pairs.",
    inputSchema: {
      type: "object",
      required: ["provider", "op"],
      properties: {
        provider: { type: "string", description: "provider id, e.g. defillama, dexscreener, lifi, evm-rpc" },
        op: { type: "string", description: "op name for that provider, e.g. protocols, search, quote" },
        args: { type: "object", description: "op arguments (free-form)" },
      },
    },
  },
  {
    name: "llama_protocols",
    description:
      "DeFiLlama: full protocol list with TVL, chain(s), category, 1d/7d change. The primary cross-chain protocol scanner. Read-only. Large payload — filter client-side.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "llama_prices",
    description:
      "DeFiLlama current prices for coins keyed 'chain:address' or 'coingecko:id' (comma-joined or array). Read-only.",
    inputSchema: {
      type: "object",
      required: ["coins"],
      properties: {
        coins: { type: "string", description: "comma-joined coin keys, e.g. 'ethereum:0x...,coingecko:bitcoin'" },
      },
    },
  },
  {
    name: "dex_search",
    description:
      "DexScreener search across all chains by symbol/name/address. Returns matching pairs with price, liquidity, volume, chain. Read-only.",
    inputSchema: {
      type: "object",
      required: ["q"],
      properties: { q: { type: "string", description: "query: symbol, name, or token address" } },
    },
  },
  {
    name: "dex_token",
    description:
      "DexScreener pairs for a specific token address (any chain). Price, liquidity, volume, pair addresses. Read-only.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string" } },
    },
  },
  {
    name: "lifi_quote",
    description:
      "LI.FI cross-chain / DEX aggregator quote (no key). Best route + expected out for a swap or bridge. Read-only.",
    inputSchema: {
      type: "object",
      required: ["fromChain", "toChain", "fromToken", "toToken", "fromAmount"],
      properties: {
        fromChain: { type: "number" },
        toChain: { type: "number" },
        fromToken: { type: "string" },
        toToken: { type: "string" },
        fromAmount: { type: "string", description: "raw integer amount (wei-scale)" },
        fromAddress: { type: "string", description: "optional; defaults to operator wallet" },
      },
    },
  },
  {
    name: "portfolio_balance",
    description:
      "Read-only balance aggregation across every configured EVM chain plus Solana, Bitcoin, and Hyperliquid. Reports native assets, supported token/collectible reads, failed or missing providers, unverified assets, timestamps, and known priced value without pretending it is a complete total. Public addresses only; never signs or broadcasts.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "object",
          description: "Optional public wallet addresses by family. Omit configured families to use ORACLE_*_ADDRESS defaults.",
          properties: {
            evm: { type: "string" },
            solana: { type: "string" },
            bitcoin: { type: "string" },
            hyperliquid: { type: "string" },
          },
        },
        evmChainIds: {
          type: "array",
          items: { type: "number" },
          description: "Optional EVM chain subset. Default is every configured EVM chain.",
        },
        includeTokens: { type: "boolean", description: "Include supported token reads. Default true." },
        includeCollectibles: { type: "boolean", description: "Include supported collectible reads. Default true." },
        includePrices: { type: "boolean", description: "Fetch current DeFiLlama native prices. Default true." },
      },
    },
  },
  {
    name: "portfolio_snapshot",
    description:
      "Query the current multichain balance and NFT inventory, then append one compact profile-local observation for historical tracking. Stores public-address fingerprint, coverage, breakdown, and known priced value only; no keys, signatures, executable payloads, or raw NFT metadata. Returns the live balance, NFT result, and recorded snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "object",
          properties: {
            evm: { type: "string" },
            solana: { type: "string" },
            bitcoin: { type: "string" },
            hyperliquid: { type: "string" },
          },
        },
        evmChainIds: { type: "array", items: { type: "number" } },
        includeTokens: { type: "boolean" },
        includeCollectibles: { type: "boolean" },
        includePrices: { type: "boolean" },
        includeNfts: { type: "boolean", description: "Include provider-estimated NFT value. Default true." },
      },
    },
  },
  {
    name: "portfolio_history",
    description:
      "Read profile-local portfolio observations in a time range. Unknown or unavailable values remain null and are never converted to zero. Defaults to the configured public-address portfolio fingerprint.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "object",
          properties: {
            evm: { type: "string" },
            solana: { type: "string" },
            bitcoin: { type: "string" },
            hyperliquid: { type: "string" },
          },
        },
        portfolioId: { type: "string" },
        allPortfolios: { type: "boolean", description: "Return observations for every public-address fingerprint in this profile." },
        since: { type: "string", description: "Inclusive ISO 8601 lower bound." },
        until: { type: "string", description: "Inclusive ISO 8601 upper bound." },
        limit: { type: "number", description: "1-1000, default 100." },
        order: { type: "string", enum: ["asc", "desc"] },
      },
    },
  },
  {
    name: "portfolio_value_graph",
    description:
      "Render a static SVG line graph from profile-local portfolio snapshots. Plots known priced value only, labels incomplete coverage, includes provider-estimated NFT values when recorded, and omits unavailable observations instead of plotting fake zeroes.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "object",
          properties: {
            evm: { type: "string" },
            solana: { type: "string" },
            bitcoin: { type: "string" },
            hyperliquid: { type: "string" },
          },
        },
        portfolioId: { type: "string" },
        allPortfolios: { type: "boolean" },
        since: { type: "string" },
        until: { type: "string" },
        limit: { type: "number", description: "Historical observations to consider, max 1000." },
        maxPoints: { type: "number", description: "Rendered point cap, 2-500, default 200." },
      },
    },
  },
  {
    name: "nft_inventory",
    description:
      "Read all discoverable NFTs for configured EVM, Solana, and Bitcoin addresses. Returns normalized assets, image URLs, estimated values, per-chain partial failures, flagged/NSFW items separated from visible items, listing coverage, and explicit unsupported chains. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "object",
          properties: {
            evm: { type: "string" },
            solana: { type: "string" },
            bitcoin: { type: "string" },
          },
        },
        chains: { type: "array", items: { type: "string" }, description: "Optional chain slug subset." },
        pageSize: { type: "number", description: "OpenSea items per page, max 200." },
        maxPages: { type: "number", description: "Maximum pages per chain, max 25." },
        bitcoinLimit: { type: "number" },
        includePnl: { type: "boolean", description: "Include OpenSea-indexed account PnL when available. Default true." },
        costBasis: { type: "object", description: "Optional user-supplied assetKey -> {costUsd,feesUsd,acquiredAt,source}. Missing basis stays unavailable, never zero." },
      },
    },
  },
  {
    name: "nft_gallery",
    description:
      "Generate one static NFT contact-sheet image page from wallet inventory or supplied normalized items. External metadata is never rendered as HTML; only allowlisted JPEG/PNG/WebP bytes are embedded and unsafe or missing media becomes a placeholder.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "object",
          properties: { evm: { type: "string" }, solana: { type: "string" }, bitcoin: { type: "string" } },
        },
        chains: { type: "array", items: { type: "string" } },
        items: { type: "array", items: { type: "object" }, description: "Optional normalized inventory items. Omit to scan configured wallets." },
        page: { type: "number", description: "1-based gallery page." },
        pageSize: { type: "number", description: "1-12 items per page." },
      },
    },
  },
  {
    name: "nft_pnl",
    description:
      "NFT PnL with explicit methodology. Returns OpenSea-indexed account-level PnL where available plus per-item unrealized estimates only when both user-supplied acquisition cost and provider estimated current value exist. Missing history is unavailable, never zero.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "object",
          properties: { evm: { type: "string" }, solana: { type: "string" }, bitcoin: { type: "string" } },
        },
        chains: { type: "array", items: { type: "string" } },
        costBasis: { type: "object" },
      },
    },
  },
  {
    name: "nft_prepare_list",
    description:
      "Prepare an NFT listing for OpenSea EVM, Magic Eden Solana, or Satflow Bitcoin after explicit user review. Requires userConfirmed=true plus asset, marketplace, price, currency where applicable, and future expiry. Magic Eden Solana also requires confirmation exactly: list <tokenMint> on magiceden-sol for <priceSol> SOL until <expiry>. Returns approval/signing actions, an unsigned Solana transaction, or an unsigned Bitcoin PSBT. Never signs, submits, or broadcasts.",
    inputSchema: {
      type: "object",
      required: ["marketplace", "userConfirmed"],
      properties: {
        marketplace: { type: "string", enum: ["opensea", "magiceden", "magiceden-sol", "satflow"] },
        userConfirmed: { type: "boolean" },
        chain: { type: "string" },
        seller: { type: "string" },
        contract: { type: "string" },
        tokenId: { type: "string" },
        quantity: { type: "number" },
        priceAmount: { type: "string" },
        currency: { type: "string" },
        endTime: { type: "string" },
        useCreatorFee: { type: "boolean" },
        taker: { type: "string" },
        tokenMint: { type: "string" },
        tokenATA: { type: "string" },
        auctionHouse: { type: "string" },
        priceSol: { type: "string" },
        expiry: { description: "Future ISO 8601 timestamp or Unix seconds. Magic Eden Solana listings require finite future expiry; no-expiry is refused." },
        confirmation: { type: "string", description: "Required for Magic Eden Solana listings. Exact phrase: list <tokenMint> on magiceden-sol for <priceSol> SOL until <expiry>." },
        inscriptionId: { type: "string" },
        runesOutput: { type: "string" },
        ordAddress: { type: "string" },
        receiveAddress: { type: "string" },
        priceSats: { type: "string" },
        tapKey: { type: "string" },
        collectionSlug: { type: "string" },
      },
    },
  },
  {
    name: "rpc_balance",
    description:
      "Native token balance of an address on a chain via public RPC. Read-only. Omit address to read the operator wallet.",
    inputSchema: {
      type: "object",
      required: ["chainId"],
      properties: {
        chainId: { type: "number" },
        address: { type: "string" },
      },
    },
  },
  {
    name: "rpc_block",
    description: "Latest block number on a chain via public RPC. Read-only.",
    inputSchema: {
      type: "object",
      required: ["chainId"],
      properties: { chainId: { type: "number" } },
    },
  },
  {
    name: "solana_balance",
    description: "Solana mainnet SOL balance for a base58 public key. Read-only; no signing or broadcast.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string" }, commitment: { type: "string" } },
    },
  },
  {
    name: "solana_token_accounts",
    description: "Solana SPL token accounts for an owner, optionally filtered by mint. Read-only.",
    inputSchema: {
      type: "object",
      required: ["owner"],
      properties: { owner: { type: "string" }, mint: { type: "string" }, commitment: { type: "string" } },
    },
  },
  {
    name: "solana_simulate",
    description: "Simulate a base64 Solana transaction through RPC. Read-only; never signs or broadcasts.",
    inputSchema: {
      type: "object",
      required: ["transaction"],
      properties: { transaction: { type: "string" }, sigVerify: { type: "boolean" }, replaceRecentBlockhash: { type: "boolean" } },
    },
  },
  {
    name: "jupiter_venues",
    description: "Jupiter Solana venue map, optionally verified on-chain against executable BPF loader ownership. Read-only.",
    inputSchema: {
      type: "object",
      properties: { verify: { type: "boolean" }, rpc: { type: "string" } },
    },
  },
  {
    name: "jupiter_quote",
    description: "Jupiter Solana Swap API quote with a hard <=100 bps slippage cap. Read-only.",
    inputSchema: {
      type: "object",
      required: ["inputMint", "outputMint", "amount"],
      properties: { inputMint: { type: "string" }, outputMint: { type: "string" }, amount: { type: "string" }, slippageBps: { type: "number" } },
    },
  },
  {
    name: "jupiter_prepare",
    description: "Prepare an unsigned Jupiter swap transaction for the user's Solana wallet to sign. No local signer, no broadcast.",
    inputSchema: {
      type: "object",
      required: ["userPublicKey"],
      properties: { userPublicKey: { type: "string" }, quoteResponse: { type: "object" }, inputMint: { type: "string" }, outputMint: { type: "string" }, amount: { type: "string" }, slippageBps: { type: "number" } },
    },
  },
  {
    name: "btc_health",
    description: "Bitcoin L1 Esplora health + tip height (mempool.space by default). No Core RPC, no keys. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "btc_fees",
    description: "Recommended Bitcoin fee rates (sats/vB). Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "btc_balance",
    description: "Bitcoin address balance in sats via Esplora. Read-only.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string", description: "bc1…/1…/3… address" } },
    },
  },
  {
    name: "btc_utxos",
    description: "UTXOs for a Bitcoin address via Esplora. Read-only.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string" } },
    },
  },
  {
    name: "btc_tx",
    description: "Lookup a Bitcoin transaction by txid via Esplora. Read-only.",
    inputSchema: {
      type: "object",
      required: ["txid"],
      properties: { txid: { type: "string" } },
    },
  },
  {
    name: "btc_meta_health",
    description:
      "Ordinals/runes indexer health. Reports whether BTC_META_API_URL / vendor API keys are configured. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "btc_rune_balance",
    description:
      "Rune balances for a Bitcoin address (requires configured indexer + optional API key). Read-only.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string" } },
    },
  },
  {
    name: "btc_inscriptions",
    description:
      "Inscriptions controlled by an address. REQUIRES a keyed indexer (ordinals.com has no address index). Returns unknownNotEmpty:true when unconfigured — that means UNKNOWN, never 'wallet holds none'. Protect these UTXOs from fee spends.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string" }, limit: { type: "number" } },
    },
  },
  {
    name: "btc_inscription_info",
    description:
      "Inscription metadata by inscription id (content type/length, height, sat, fee). KEYLESS via ordinals.com recursive. Read-only.",
    inputSchema: {
      type: "object",
      required: ["inscriptionId"],
      properties: {
        inscriptionId: { type: "string", description: "<64-hex-txid>i<index>" },
      },
    },
  },
  {
    name: "btc_inscription_children",
    description:
      "Child inscriptions of a parent (collections). KEYLESS via ordinals.com recursive. Read-only.",
    inputSchema: {
      type: "object",
      required: ["inscriptionId"],
      properties: {
        inscriptionId: { type: "string", description: "<64-hex-txid>i<index>" },
        page: { type: "number" },
      },
    },
  },
  {
    name: "btc_ord_block_info",
    description:
      "Ord node block info / indexer tip. KEYLESS. Use to confirm the ordinals indexer is at the same tip as Esplora before trusting metaprotocol reads.",
    inputSchema: {
      type: "object",
      properties: { height: { type: "number", description: "omit for current tip" } },
    },
  },
  {
    name: "satflow_health",
    description:
      "Satflow marketplace health (primary BTC ordinals/runes market after Magic Eden BTC sunset). Needs SATFLOW_API_KEY. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "satflow_floors",
    description: "Satflow collection floor prices. type=ordinals|runes. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "ordinals or runes" },
        ids: { type: "string", description: "optional comma-separated collection ids" },
      },
    },
  },
  {
    name: "satflow_wallet",
    description: "Satflow wallet contents (ordinals/runes) for an address. Read-only.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string" }, type: { type: "string" }, limit: { type: "number" } },
    },
  },
  {
    name: "satflow_item",
    description: "Satflow item detail for an inscription id (listing + bids + meta). Read-only.",
    inputSchema: {
      type: "object",
      required: ["inscriptionId"],
      properties: { inscriptionId: { type: "string" } },
    },
  },
  {
    name: "satflow_floor_listings",
    description: "Satflow floor listings for collection id(s). Read-only.",
    inputSchema: {
      type: "object",
      required: ["collectionIds"],
      properties: { collectionIds: { type: "string" }, limit: { type: "number" } },
    },
  },
  {
    name: "scanner_coverage",
    description:
      "Which chains the on-chain scanner supports and which capabilities each one has " +
      "(blockNumber, nativeBalance, tokenBalance, resolveToken, resolvePools, scanBlocks, " +
      "scoreRisk, quote, sellSimulation, prepareUnsignedTx). Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "scan_token",
    description:
      "Resolve a token on an EVM chain: metadata, its pools, and a risk score. Works on " +
      "chains no indexer covers because it reads the chain directly. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number", description: "EVM chain id, e.g. 4663 for Robinhood Chain" },
        token: { type: "string", description: "token contract address" },
      },
      required: ["chainId", "token"],
    },
  },
  {
    name: "wallet_balances",
    description:
      "Native balance for an address on an EVM chain, plus one token balance when a token " +
      "address is supplied. Read-only; never signs.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
        address: { type: "string", description: "wallet address to inspect" },
        token: { type: "string", description: "optional token contract for a token balance" },
      },
      required: ["chainId", "address"],
    },
  },
  {
    name: "address_book_remember",
    description:
      "Remember a wallet address with a label. Call this whenever someone states their address " +
      "or an agent/counterparty wallet is discovered, so it survives the conversation. " +
      "Stores labels only — never private keys, seeds, or passphrases.",
    inputSchema: {
      type: "object",
      required: ["address", "label"],
      properties: {
        address: { type: "string", description: "0x address" },
        label: { type: "string", description: "short name, e.g. research-agent" },
        who: { type: "string", description: "person or entity the wallet belongs to" },
        role: { type: "string", description: "agent | owner | person | counterparty | venue" },
        chainIds: { type: "array", items: { type: "number" } },
        notes: { type: "string" },
      },
    },
  },
  {
    name: "address_book_list",
    description:
      "List remembered wallets (owner, agent, people, counterparties). Read-only. " +
      "Check this before sending or bridging to a person.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "search across label, who, address, notes" },
        role: { type: "string" },
        who: { type: "string" },
      },
    },
  },
  {
    name: "address_book_lookup",
    description: "Look up one 0x address in the durable address book. Read-only.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string" } },
    },
  },
  {
    name: "address_book_forget",
    description: "Remove a remembered address, optionally only one label for it.",
    inputSchema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string" }, label: { type: "string" } },
    },
  },
  {
    name: "rfq_quote",
    description:
      "Create a cross-chain RFQ intent and fan it out to reviewed solver or venue sources. " +
      "Returns firm quote objects with intentHash, firmQuoteHash, expiry, min receive, " +
      "and unsigned executable artifacts. Never signs or broadcasts.",
    inputSchema: {
      type: "object",
      required: ["fromChainId", "toChainId", "sellToken", "buyToken", "sellAmount", "receiver", "deadlineMs"],
      properties: {
        fromChainId: { type: "number" },
        toChainId: { type: "number" },
        sellToken: { type: "string" },
        buyToken: { type: "string" },
        sellAmount: { type: "string" },
        receiver: { type: "string" },
        deadlineMs: { type: "number" },
        minBuyAmount: { type: "string" },
        allowedSources: { type: "array", items: { type: "string" } },
        allowedRouters: { type: "array", items: { type: "string" } },
        slippageBps: { type: "number" },
        decimalsIn: { type: "number" },
        decimalsOut: { type: "number" },
      },
    },
  },
  {
    name: "best_swap_route",
    description:
      "Compare swap routes across every available aggregator and rank by NET output " +
      "(after gas and fees), not headline quote. Returns the winner plus all " +
      "runners-up so the ranking can be checked rather than trusted.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number", description: "EVM chain id, e.g. 8453 for Base" },
        tokenIn: { type: "string", description: "sell token address" },
        tokenOut: { type: "string", description: "buy token address" },
        amountIn: { type: "string", description: "raw units of tokenIn (wei-scale)" },
        taker: { type: "string", description: "address used for quoting only; nothing is signed" },
        decimalsIn: { type: "number" },
        decimalsOut: { type: "number" },
      },
      required: ["chainId", "tokenIn", "tokenOut", "amountIn"],
    },
  },
  {
    name: "best_bridge_route",
    description:
      "Compare cross-chain bridge routes and rank by NET output. Also reports each " +
      "route's expected duration, which is NOT folded into the score -- a route that " +
      "saves $2 but takes 30 minutes is a trade-off for the caller to make.",
    inputSchema: {
      type: "object",
      properties: {
        fromChainId: { type: "number" },
        toChainId: { type: "number" },
        tokenIn: { type: "string", description: "token on the origin chain" },
        tokenOut: { type: "string", description: "token on the destination chain" },
        amountIn: { type: "string", description: "raw units of tokenIn" },
        taker: { type: "string", description: "address used for quoting only" },
        decimalsOut: { type: "number" },
      },
      required: ["fromChainId", "toChainId", "tokenIn", "tokenOut", "amountIn"],
    },
  },
  {
    name: "prepare_best_route",
    description:
      "Compare routes, then build the SIGNABLE artifact for the winner. Returns an " +
      "unsigned transaction (LI.FI/ParaSwap/0x) or EIP-712 typed data for an " +
      "off-chain order (CoW) -- the artifactKind field says which, and they require " +
      "different wallet actions. Re-quotes before preparing and reports drift " +
      "against the comparison. Never signs or broadcasts.",
    inputSchema: {
      type: "object",
      properties: {
        chainId: { type: "number" },
        tokenIn: { type: "string" },
        tokenOut: { type: "string" },
        amountIn: { type: "string", description: "raw units of tokenIn" },
        taker: {
          type: "string",
          description:
            "the REAL wallet that will sign. Placeholder/burn addresses are rejected: " +
            "quoting is anonymous, preparing is not.",
        },
        decimalsIn: { type: "number" },
        decimalsOut: { type: "number" },
        source: {
          type: "string",
          description: "force a specific source instead of the winner (flagged in the result)",
        },
        driftToleranceBps: { type: "number", description: "default 100" },
      },
      required: ["chainId", "tokenIn", "tokenOut", "amountIn", "taker"],
    },
  },
  {
    name: "prepare_best_bridge_route",
    description:
      "Compare cross-chain bridge routes, then build the signable transaction " +
      "sequence for the winner. Returns a LIST of unsigned transactions -- some " +
      "routes need an approval and a deposit signed in order, and signing only the " +
      "first leaves funds approved but not bridged. Reports the destination chain " +
      "and expected credit time. Bridging is not atomic. Never signs or broadcasts.",
    inputSchema: {
      type: "object",
      properties: {
        fromChainId: { type: "number" },
        toChainId: { type: "number" },
        tokenIn: { type: "string", description: "token on the origin chain" },
        tokenOut: { type: "string", description: "token on the destination chain" },
        amountIn: { type: "string", description: "raw units of tokenIn" },
        taker: { type: "string", description: "the REAL wallet that will sign; placeholders rejected" },
        source: { type: "string", description: "force a source instead of the winner" },
        driftToleranceBps: { type: "number", description: "default 100" },
      },
      required: ["fromChainId", "toChainId", "tokenIn", "tokenOut", "amountIn", "taker"],
    },
  },
  {
    name: "equity_venues",
    description:
      "Inventory of on-chain equities venues (HIP-3 builder DEXes, Arcus perps/spot on " +
      "Robinhood 4663, RH Uniswap prepare tier, Solana xStocks, TON ston.fi) with tiers " +
      "and a liveness snapshot. Offline fixtures by default. Read-only / prepare-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "equity_quote",
    description:
      "Cross-chain best-execution comparison for a tokenized equity ticker (NVDA, SPY, " +
      "TSLA, ...). Ranks HIP-3, Arcus, RH Uniswap, Solana xStocks, and TON. Returns " +
      "winner + runners-up + bestPreparable (only rh_uniswap is preparable in v1). " +
      "rankedOn is usually gross because fees/gas are unmeasured - say so. Never signs.",
    inputSchema: {
      type: "object",
      required: ["ticker"],
      properties: {
        ticker: { type: "string", description: "equity ticker, e.g. NVDA, SPY, TSLA" },
        sizeUsd: { type: "string", description: "optional notional USD size for impact model" },
        horizonHours: {
          type: "number",
          description: "optional holding horizon; enables funding-adjusted spot-vs-perp ranking",
        },
      },
    },
  },
  {
    name: "equity_prepare",
    description:
      "Prepare an UNSIGNED Robinhood-chain Uniswap artifact for a tokenized equity. " +
      "Only the prepare-tier venue (rh_uniswap / chain 4663). Requires the real wallet " +
      "as recipient. requiresWalletSignature=true, backendSigner=false. Never signs or broadcasts.",
    inputSchema: {
      type: "object",
      required: ["ticker", "recipient"],
      properties: {
        ticker: { type: "string" },
        recipient: {
          type: "string",
          description: "the REAL 0x wallet that will sign; placeholders rejected",
        },
        sizeUsd: { type: "string", description: "optional notional USD size" },
      },
    },
  },
  {
    name: "twap_simulate",
    description:
      "Simulate a TWAP (time-weighted average price) DCA order. Splits a large " +
      "order into equal-sized chunks over a configurable window, quotes every chunk " +
      "at current prices, and returns the schedule + estimated average price. " +
      "Read-only. Never signs or broadcasts. Use before committing to a TWAP.",
    inputSchema: {
      type: "object",
      required: ["chainId", "tokenIn", "tokenOut", "amount", "taker"],
      properties: {
        chainId: { type: "number" },
        tokenIn: { type: "string" },
        tokenOut: { type: "string" },
        amount: { type: "string", description: "raw base units of tokenIn" },
        taker: { type: "string", description: "the REAL wallet that will sign" },
        splits: { type: "number", description: "number of chunks (default 10, max 100)" },
        windowHours: { type: "number", description: "total window in hours (default 6)" },
        slippageBps: { type: "number", description: "slippage cap in bps (default 100)" },
      },
    },
  },
  {
    name: "bridge_aggregator_scan",
    description:
      "Scan ALL cross-chain bridge routes: deBridge DLN + LI.FI/Relay + ChangeNOW. " +
      "Ranks every route by net output, checks for existing token approvals that " +
      "should be revoked before bridging, and returns the winner + runners-up. " +
      "Read-only. Never signs or broadcasts. ChangeNOW requires ticker symbols.",
    inputSchema: {
      type: "object",
      required: ["fromChainId", "toChainId", "tokenIn", "tokenOut", "amount", "taker"],
      properties: {
        fromChainId: { type: "number" },
        toChainId: { type: "number" },
        tokenIn: { type: "string" },
        tokenOut: { type: "string" },
        amount: { type: "string", description: "raw base units of tokenIn" },
        taker: { type: "string" },
        fromSymbol: { type: "string", description: "ticker for ChangeNOW (e.g. ETH, USDC)" },
        toSymbol: { type: "string", description: "ticker for ChangeNOW" },
        fromDecimals: { type: "number", description: "default 18" },
        toDecimals: { type: "number", description: "default 18" },
      },
    },
  },
  {
    name: "perps_markets",
    description:
      "Scan perps markets across dYdX (standalone chain), Drift (Solana), and Vertex " +
      "(Arbitrum). Returns ticker, oracle price, funding rate, open interest, and " +
      "24h volume. Read-only. Never signs.",
    inputSchema: {
      type: "object",
      properties: {
        venue: { type: "string", description: "dydx, drift, or vertex (default: all)" },
      },
    },
  },
  {
    name: "dex_quote",
    description:
      "Quote a swap across PancakeSwap (BSC+), SushiSwap (30+ chains), or Raydium " +
      "(Solana via Jupiter). Specify the DEX and chain. Read-only.",
    inputSchema: {
      type: "object",
      required: ["dex", "chainId", "tokenIn", "tokenOut", "amountIn"],
      properties: {
        dex: { type: "string", description: "pancakeswap, sushiswap, or raydium" },
        chainId: { type: "number" },
        tokenIn: { type: "string" },
        tokenOut: { type: "string" },
        amountIn: { type: "string", description: "raw base units" },
      },
    },
  },
  {
    name: "options_markets",
    description:
      "Scan on-chain options markets (calls/puts). Currently Aevo. " +
      "Returns instruments, mark prices, funding, open interest. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lending_markets",
    description:
      "Scan lending protocol markets across Compound ($2B+ TVL). " +
      "Returns supply/borrow APYs, total supply, collateral factors. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "yield_vaults",
    description:
      "Scan yield aggregator vaults across Yearn + Convex. " +
      "Returns vault APYs, TVLs, boosted status. Read-only.",
    inputSchema: { type: "object", properties: {} },
  },
];

// Named tool -> { provider, op, argMap(args) }
//
// A default address for read tools (rpc_balance, lifi fromAddress) is read from env
// and is entirely optional. When unset, those tools require an explicit address --
// which is the correct default for a public tool: silently substituting SOMEONE'S
// wallet would both leak whose it is and quote routes against the wrong balances.
const DEFAULT_ADDRESS = String(
  process.env.ORACLE_DEFAULT_ADDRESS || process.env.MAD_OPERATOR_ADDRESS || "",
).trim();
const ROUTES = {
  llama_protocols: () => ({ provider: "defillama", op: "protocols", args: {} }),
  llama_prices: (a) => ({ provider: "defillama", op: "prices", args: { coins: a.coins } }),
  dex_search: (a) => ({ provider: "dexscreener", op: "search", args: { q: a.q } }),
  dex_token: (a) => ({ provider: "dexscreener", op: "token", args: { address: a.address } }),
  lifi_quote: (a) => ({
    provider: "lifi",
    op: "quote",
    args: {
      fromChain: a.fromChain,
      toChain: a.toChain,
      fromToken: a.fromToken,
      toToken: a.toToken,
      fromAmount: a.fromAmount,
      fromAddress: a.fromAddress || DEFAULT_ADDRESS || undefined,
    },
  }),
  portfolio_balance: (a) => ({
    provider: "portfolio",
    op: "balances",
    args: {
      addresses: a.addresses,
      evmChainIds: a.evmChainIds,
      includeTokens: a.includeTokens,
      includeCollectibles: a.includeCollectibles,
      includePrices: a.includePrices,
    },
  }),
  portfolio_snapshot: (a) => ({ provider: "portfolio", op: "snapshot", args: a }),
  portfolio_history: (a) => ({ provider: "portfolio", op: "history", args: a }),
  portfolio_value_graph: (a) => ({ provider: "portfolio", op: "valueGraph", args: a }),
  nft_inventory: (a) => ({ provider: "nft-portfolio", op: "inventory", args: a }),
  nft_gallery: (a) => ({ provider: "nft-portfolio", op: "gallery", args: a }),
  nft_pnl: (a) => ({ provider: "nft-portfolio", op: "pnl", args: a }),
  nft_prepare_list: (a) => ({ provider: "nft-portfolio", op: "prepareList", args: a }),
  rpc_balance: (a) => {
    const addr = a.address || DEFAULT_ADDRESS;
    if (!addr) throw new Error("address required (set ORACLE_DEFAULT_ADDRESS to supply a default)");
    return { provider: "evm-rpc", op: "getBalance", args: { chainId: a.chainId, address: addr } };
  },
  rpc_block: (a) => ({ provider: "evm-rpc", op: "blockNumber", args: { chainId: a.chainId } }),
  solana_balance: (a) => ({ provider: "solana-rpc", op: "getBalance", args: { address: a.address, commitment: a.commitment } }),
  solana_token_accounts: (a) => ({ provider: "solana-rpc", op: "tokenAccounts", args: { owner: a.owner, mint: a.mint, commitment: a.commitment } }),
  solana_simulate: (a) => ({ provider: "solana-rpc", op: "simulate", args: { transaction: a.transaction, sigVerify: a.sigVerify, replaceRecentBlockhash: a.replaceRecentBlockhash } }),
  jupiter_venues: (a) => ({ provider: "jupiter", op: "venues", args: { verify: a.verify, rpc: a.rpc } }),
  jupiter_quote: (a) => ({ provider: "jupiter", op: "quote", args: { inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, slippageBps: a.slippageBps } }),
  jupiter_prepare: (a) => ({ provider: "jupiter", op: "prepare", args: { userPublicKey: a.userPublicKey, quoteResponse: a.quoteResponse, inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, slippageBps: a.slippageBps } }),
  btc_health: () => ({ provider: "bitcoin-esplora", op: "health", args: {} }),
  btc_fees: () => ({ provider: "bitcoin-esplora", op: "fees", args: {} }),
  btc_balance: (a) => ({ provider: "bitcoin-esplora", op: "address", args: { address: a.address } }),
  btc_utxos: (a) => ({ provider: "bitcoin-esplora", op: "utxos", args: { address: a.address } }),
  btc_tx: (a) => ({ provider: "bitcoin-esplora", op: "tx", args: { txid: a.txid } }),
  btc_meta_health: () => ({ provider: "bitcoin-meta", op: "health", args: {} }),
  btc_rune_balance: (a) => ({ provider: "bitcoin-meta", op: "runeBalances", args: { address: a.address } }),
  btc_inscriptions: (a) => ({
    provider: "bitcoin-meta",
    op: "inscriptions",
    args: { address: a.address, limit: a.limit },
  }),
  btc_inscription_info: (a) => ({
    provider: "bitcoin-meta",
    op: "inscriptionInfo",
    args: { inscriptionId: a.inscriptionId },
  }),
  btc_inscription_children: (a) => ({
    provider: "bitcoin-meta",
    op: "inscriptionChildren",
    args: { inscriptionId: a.inscriptionId, page: a.page },
  }),
  btc_ord_block_info: (a) => ({
    provider: "bitcoin-meta",
    op: "ordBlockInfo",
    args: { height: a.height },
  }),
  satflow_health: () => ({ provider: "satflow", op: "health", args: {} }),
  satflow_floors: (a) => ({
    provider: "satflow",
    op: "collectionFloors",
    args: { type: a.type, ids: a.ids },
  }),
  satflow_wallet: (a) => ({
    provider: "satflow",
    op: "walletContents",
    args: { address: a.address, type: a.type, limit: a.limit },
  }),
  satflow_item: (a) => ({
    provider: "satflow",
    op: "item",
    args: { inscriptionId: a.inscriptionId || a.id },
  }),
  satflow_floor_listings: (a) => ({
    provider: "satflow",
    op: "floorListings",
    args: { collectionIds: a.collectionIds || a.ids, limit: a.limit },
  }),
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function httpJson(url, { method = "GET", body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function deskCall(provider, op, args = {}) {
  return httpJson(`${DATA_URL}/data/call`, {
    method: "POST",
    body: { provider, op, args },
  });
}

async function callTool(name, args = {}) {
  if (name === "rfq_quote") {
    const { normalizeRfqIntent } = await import("../src/rfq/intent.mjs");
    const { requestRfqQuotes } = await import("../src/rfq/sources.mjs");
    const intent = normalizeRfqIntent({ ...args, sources: args.sources ?? args.allowedSources });
    return requestRfqQuotes(intent, { decimalsIn: args.decimalsIn, decimalsOut: args.decimalsOut });
  }
  // Routing runs IN-PROCESS rather than through the desk HTTP server. The router
  // fans out to several aggregators itself, so proxying it through /data/call would
  // add a hop and a second timeout budget for no benefit -- and it means routing
  // works without a desk server running at all.
  if (name === "best_swap_route" || name === "best_bridge_route") {
    const { bestSwapRoute, bestBridgeRoute } = await import("../src/router/index.mjs");
    return name === "best_swap_route" ? bestSwapRoute(args) : bestBridgeRoute(args);
  }
  if (name === "prepare_best_route") {
    const { prepareBestRoute } = await import("../src/router/prepare-route.mjs");
    return prepareBestRoute(args);
  }
  if (name === "prepare_best_bridge_route") {
    const { prepareBestBridgeRoute } = await import("../src/router/prepare-bridge.mjs");
    return prepareBestBridgeRoute(args);
  }
  // TWAP (time-weighted average price) DCA simulation.
  if (name === "twap_simulate") {
    const { simulateTwap } = await import("../src/data/providers/twap.mjs");
    return simulateTwap(args);
  }
  // Bridge aggregator: deBridge + Squid + Stargate + THORChain + LI.FI + ChangeNOW + revoke.
  if (name === "bridge_aggregator_scan") {
    const { scanBridgeRoutes } = await import("../src/data/providers/bridge-aggregator.mjs");
    return scanBridgeRoutes(args);
  }
  // Perps markets: dYdX, Drift, Vertex.
  if (name === "perps_markets") {
    const venue = String(args.venue || "all").toLowerCase();
    const results = {};
    if (venue === "all" || venue === "dydx") {
      const { dydxMarkets } = await import("../src/data/providers/dydx.mjs");
      results.dydx = await dydxMarkets();
    }
    if (venue === "all" || venue === "drift") {
      const { driftMarkets } = await import("../src/data/providers/drift.mjs");
      results.drift = await driftMarkets();
    }
    if (venue === "all" || venue === "vertex") {
      const { vertexMarkets } = await import("../src/data/providers/vertex.mjs");
      results.vertex = await vertexMarkets();
    }
    return results;
  }
  // DEX quotes: PancakeSwap, SushiSwap, Raydium.
  if (name === "dex_quote") {
    const dex = String(args.dex || "").toLowerCase();
    if (dex === "pancakeswap") {
      const { pancakeQuote } = await import("../src/data/providers/pancakeswap.mjs");
      return pancakeQuote(args);
    }
    if (dex === "sushiswap") {
      const { sushiQuote } = await import("../src/data/providers/sushiswap.mjs");
      return sushiQuote(args);
    }
    if (dex === "raydium") {
      const { raydiumQuote } = await import("../src/data/providers/raydium.mjs");
      return raydiumQuote(args);
    }
    return { error: `unknown dex: ${dex} — use pancakeswap, sushiswap, or raydium` };
  }
  // Options markets.
  if (name === "options_markets") {
    const { aevoMarkets } = await import("../src/data/providers/aevo.mjs");
    return { aevo: await aevoMarkets() };
  }
  // Lending markets.
  if (name === "lending_markets") {
    const { compoundMarkets } = await import("../src/data/providers/compound.mjs");
    return { compound: await compoundMarkets() };
  }
  // Yield vaults.
  if (name === "yield_vaults") {
    const [{ yearnVaults }, { convexPools }] = await Promise.all([
      import("../src/data/providers/yearn.mjs"),
      import("../src/data/providers/convex.mjs"),
    ]);
    return { yearn: await yearnVaults(), convex: await convexPools() };
  }
  // On-chain equities best-ex (HIP-3 / Arcus / RH / Solana / TON). In-process,
  // fixtures-backed offline, prepare-only. No desk hop required.
  if (name === "equity_venues") {
    const { equityVenues, toJsonSafe } = await import("../src/equities/index.mjs");
    return toJsonSafe(equityVenues());
  }
  if (name === "equity_quote") {
    const { bestEquityRoute, toJsonSafe } = await import("../src/equities/index.mjs");
    return toJsonSafe(
      bestEquityRoute({
        ticker: args.ticker,
        sizeUsd: args.sizeUsd,
        horizonHours: args.horizonHours,
      }),
    );
  }
  if (name === "equity_prepare") {
    const { prepareEquityRoute, toJsonSafe } = await import("../src/equities/index.mjs");
    return toJsonSafe(
      prepareEquityRoute({
        ticker: args.ticker,
        recipient: args.recipient || args.taker,
        sizeUsd: args.sizeUsd,
      }),
    );
  }
  // Smart-wallet / token scanner surface.
  //
  // The scanner engine already covered 11 chains and every capability below, but no
  // MCP tool exposed it -- so an agent could scan nothing on EVM while the code sat
  // there working. Same class of gap as a route source with no preparer: the
  // capability existed, the handle did not.
  //
  // In-process for the same reason routing is: no desk server required.
  // Read-only. scoreRisk and sellSimulation inspect; they never sign.
  if (name === "scanner_coverage") {
    const s = await import("../src/scanner/index.mjs");
    s.registerBuiltinScanners?.();
    return s.scannerCoverage();
  }
  if (name === "scan_token") {
    const s = await import("../src/scanner/index.mjs");
    s.registerBuiltinScanners?.();
    const sc = s.getScanner(Number(args.chainId));
    if (!sc) throw new Error(`no scanner registered for chainId ${args.chainId}`);
    const token = await sc.resolveToken(args.token);
    const pools = sc.supports?.("resolvePools") ? await sc.resolvePools(args.token).catch(() => null) : null;
    const risk = sc.supports?.("scoreRisk") ? await sc.scoreRisk({ token: args.token }).catch(() => null) : null;
    return { chainId: Number(args.chainId), token, pools, risk };
  }
  if (name === "wallet_balances") {
    const s = await import("../src/scanner/index.mjs");
    s.registerBuiltinScanners?.();
    const sc = s.getScanner(Number(args.chainId));
    if (!sc) throw new Error(`no scanner registered for chainId ${args.chainId}`);
    const native = await sc.nativeBalance(args.address);
    const token = args.token ? await sc.tokenBalance(args.address, args.token).catch(() => null) : null;
    return { chainId: Number(args.chainId), address: args.address, native, token };
  }
  if (name === "address_book_remember") {
    return rememberAddress({
      address: args.address, label: args.label, who: args.who,
      role: args.role, chainIds: args.chainIds, notes: args.notes, source: "oracle-data-mcp",
    });
  }
  if (name === "address_book_list") return listAddresses({ q: args.q, role: args.role, who: args.who });
  if (name === "address_book_lookup") return lookupAddress(args.address);
  if (name === "address_book_forget") return forgetAddress(args.address, args.label || null);
  if (name === "data_catalog") return httpJson(`${DATA_URL}/data/catalog`);
  if (name === "data_health") return httpJson(`${DATA_URL}/data/health`);
  if (name === "data_call") {
    if (!args.provider || !args.op) throw new Error("provider and op are required");
    return deskCall(args.provider, args.op, args.args || {});
  }
  const route = ROUTES[name];
  if (route) {
    const { provider, op, args: mapped } = route(args);
    return deskCall(provider, op, mapped);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "oracle-data-mcp", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      if (result?.dataBase64 && /^image\/(?:svg\+xml|png|jpeg|webp)$/.test(String(result.mimeType || ""))) {
        const { dataBase64, ...metadata } = result;
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              { type: "image", data: dataBase64, mimeType: result.mimeType },
              { type: "text", text: JSON.stringify(metadata, null, 2) },
            ],
          },
        });
      } else {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      }
    } catch (err) {
      send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: err.message }] } });
    }
    return;
  }
  if (id !== undefined) error(id, -32601, `Method not found: ${method}`);
}

let buffer = "";

function startStdioLoop() {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        void handle(JSON.parse(line));
      } catch (err) {
        error(null, -32700, err.message);
      }
    }
  });
}

// npm bin wrappers are symlinks. Comparing import.meta.url to argv[1] as strings
// fails for `npx oracle-data-mcp` / node_modules/.bin/oracle-data-mcp and the
// process exits without ever starting the stdio loop (Hermes sees Connection closed).
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startStdioLoop();
}

export { tools, callTool, handle };
