export type OracleRouteMethod = "GET" | "POST";
export type OracleChainFamily = "evm" | "solana" | "bitcoin" | "hyperliquid";

export type OracleReadRoute = {
  id: string;
  method: OracleRouteMethod;
  path: string;
  upstreamPath: string;
};

export type OracleChain = {
  id: string;
  label: string;
  shortLabel: string;
  family: OracleChainFamily;
  chainId: number | null;
  nativeSymbol: string;
  accent: string;
};

export const ORACLE_DATA_PLANE = {
  defaultBaseUrl: "http://127.0.0.1:8787",
  identity: {
    service: "oracle",
    plane: "data+onboard",
    exec: false,
  },
  routes: {
    health: { id: "health", method: "GET", path: "/api/oracle/status", upstreamPath: "/health" },
    catalog: { id: "catalog", method: "GET", path: "/api/oracle/catalog", upstreamPath: "/data/catalog" },
    providerHealth: { id: "providerHealth", method: "GET", path: "/api/oracle/health", upstreamPath: "/data/health" },
    portfolio: { id: "portfolio", method: "GET", path: "/api/oracle/portfolio", upstreamPath: "/public/portfolio" },
    nfts: { id: "nfts", method: "GET", path: "/api/oracle/nfts", upstreamPath: "/public/nfts" },
    approvals: { id: "approvals", method: "GET", path: "/api/oracle/approvals", upstreamPath: "/public/approvals" },
  },
} as const;

export const ORACLE_SIGNER_CONTRACT = {
  loopbackOnly: true,
  routes: {
    status: { id: "signer.status", method: "GET", path: "/api/oracle/signer", upstreamPath: "/health" },
    prepareSwap: { id: "swap.prepare", method: "POST", path: "/api/oracle/swap/prepare", upstreamPath: "/swap/prepare" },
    prepareRevoke: { id: "revoke.prepare", method: "POST", path: "/api/oracle/revoke/prepare", upstreamPath: "/revoke/prepare" },
  },
} as const;

export type OracleDataRouteId = keyof typeof ORACLE_DATA_PLANE.routes;
export type OracleSignerRouteId = keyof typeof ORACLE_SIGNER_CONTRACT.routes;

export type OracleSignerStatus = {
  configured: boolean;
  reachable: boolean;
  armed: boolean;
  surfaces: string[];
  error: string | null;
};

export type OracleSwapPrepareRequest = {
  chainId: string;
  sellSymbol: string;
  buySymbol: string;
  sellAmount: string;
};

export type OracleSwapPrepareResponse<Quote = unknown> = {
  configured: boolean;
  reachable: boolean;
  error: string | null;
  quote: Quote | null;
  requiresWalletSignature: true;
  backendSigner: false;
};

/**
 * `operator-all` is its own tier because it is not an amount at all: an
 * ERC-721/1155 operator may move EVERY item in the collection. It outranks
 * `unlimited`, which is still bounded by one token's balance.
 */
export type OracleApprovalRisk =
  | "operator-all"
  | "unlimited"
  | "stale"
  | "unknown-spender"
  | "scoped";

/** Approval shape. ERC-20 grants an amount; ERC-721/1155 grants the collection. */
export type OracleApprovalStandard = "erc20" | "erc721";

/**
 * Shared approval vocabulary.
 *
 * The scanning provider (packages/oracle) and the public app classify the same
 * approvals, but the app cannot import the provider: it depends only on this
 * contract package, and the boundary gate keeps execution-capable code out of
 * the public keyless bundle. Duplicating the rules in both places is what let
 * an NFT-shaped approval get classified one way upstream and silently dropped
 * downstream. Both sides now agree by construction, here.
 */

/** Allowances at or above this are unbounded for any realistic token supply. */
export const ORACLE_UNLIMITED_FLOOR = ((1n << 256n) - 1n) / 2n;

/** An approval untouched for this long is surfaced as stale. */
export const ORACLE_STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

/** Risk tiers, most severe first. Order is the display and sort order. */
export const ORACLE_APPROVAL_RISKS: readonly OracleApprovalRisk[] = Object.freeze([
  "operator-all",
  "unlimited",
  "unknown-spender",
  "stale",
  "scoped",
]);

/**
 * Classify one approval.
 *
 * An ERC-721 operator grant is not an amount at all — it is control of every
 * item in the collection — so it outranks `unlimited`, which is still bounded
 * by a single token's balance.
 */
export function oracleApprovalRisk(input: {
  standard: OracleApprovalStandard;
  unlimited: boolean;
  spenderLabel: string | null;
  lastActivityAt: string | null;
}): OracleApprovalRisk {
  if (input.standard === "erc721") return "operator-all";
  if (input.unlimited) return "unlimited";
  if (!input.spenderLabel) return "unknown-spender";
  if (input.lastActivityAt) {
    const seen = Date.parse(input.lastActivityAt);
    if (Number.isFinite(seen) && Date.now() - seen > ORACLE_STALE_AFTER_MS) return "stale";
  }
  return "scoped";
}

/** Render an allowance for display. Operator grants have no amount. */
export function oracleAllowanceDisplay(
  raw: bigint | null,
  decimals: number | null,
  standard: OracleApprovalStandard,
): string {
  if (standard === "erc721") return "ALL ITEMS";
  if (raw === null) return "UNKNOWN";
  if (raw >= ORACLE_UNLIMITED_FLOOR) return "UNLIMITED";
  if (decimals === null) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = raw % base;
  if (fraction === 0n) return whole.toLocaleString("en-US");
  const padded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  return `${whole.toLocaleString("en-US")}${padded ? `.${padded}` : ""}`;
}

export type OracleApproval = {
  id: string;
  chainId: string;
  chainNumericId: number | null;
  standard: OracleApprovalStandard;
  token: string;
  tokenSymbol: string | null;
  spender: string;
  spenderLabel: string | null;
  /** Null for operator grants: there is no amount, the whole collection is exposed. */
  allowance: string | null;
  allowanceDisplay: string;
  unlimited: boolean;
  decimals: number | null;
  lastActivityAt: string | null;
  risk: OracleApprovalRisk;
};

/**
 * Unsigned revoke material. The server prepares calldata only. It never signs,
 * never broadcasts, and never holds key material. A wallet the user controls
 * must independently review and sign before anything reaches a chain.
 */
export type OracleRevokePrepareResponse = {
  configured: boolean;
  reachable: boolean;
  error: string | null;
  transaction: {
    to: string;
    data: string;
    value: "0x0";
    chainId: number;
  } | null;
  intentHash: string | null;
  requiresWalletSignature: true;
  backendSigner: false;
};

export const ORACLE_CHAINS: readonly OracleChain[] = Object.freeze([
  { id: "ethereum", label: "Ethereum", shortLabel: "Ethereum", family: "evm", chainId: 1, nativeSymbol: "ETH", accent: "#88B7FF" },
  { id: "base", label: "Base", shortLabel: "Base", family: "evm", chainId: 8453, nativeSymbol: "ETH", accent: "#5E9EFF" },
  { id: "arbitrum", label: "Arbitrum One", shortLabel: "Arbitrum", family: "evm", chainId: 42161, nativeSymbol: "ETH", accent: "#6DB6E8" },
  { id: "optimism", label: "OP Mainnet", shortLabel: "Optimism", family: "evm", chainId: 10, nativeSymbol: "ETH", accent: "#FF6B75" },
  { id: "polygon", label: "Polygon", shortLabel: "Polygon", family: "evm", chainId: 137, nativeSymbol: "POL", accent: "#A78BFA" },
  { id: "bsc", label: "BNB Smart Chain", shortLabel: "BNB", family: "evm", chainId: 56, nativeSymbol: "BNB", accent: "#F3BA2F" },
  { id: "avalanche", label: "Avalanche C-Chain", shortLabel: "Avalanche", family: "evm", chainId: 43114, nativeSymbol: "AVAX", accent: "#E76A72" },
  { id: "robinhood", label: "Robinhood Chain", shortLabel: "Robinhood", family: "evm", chainId: 4663, nativeSymbol: "ETH", accent: "#D7FF4D" },
  { id: "hyperevm", label: "HyperEVM", shortLabel: "HyperEVM", family: "evm", chainId: 999, nativeSymbol: "HYPE", accent: "#69E3C4" },
  { id: "abstract", label: "Abstract", shortLabel: "Abstract", family: "evm", chainId: 2741, nativeSymbol: "ETH", accent: "#A5F3C6" },
  { id: "stable", label: "Stable Mainnet", shortLabel: "Stable", family: "evm", chainId: 988, nativeSymbol: "USDT0", accent: "#8FE3C7" },
  { id: "solana", label: "Solana", shortLabel: "Solana", family: "solana", chainId: null, nativeSymbol: "SOL", accent: "#9A8CFF" },
  { id: "bitcoin", label: "Bitcoin", shortLabel: "Bitcoin", family: "bitcoin", chainId: null, nativeSymbol: "BTC", accent: "#F3A847" },
  { id: "hyperliquid", label: "Hyperliquid", shortLabel: "Hyperliquid", family: "hyperliquid", chainId: null, nativeSymbol: "USDC", accent: "#79E6D1" },
]);

export const ORACLE_EVM_CHAIN_IDS = Object.freeze(
  ORACLE_CHAINS.filter((chain) => chain.family === "evm").map((chain) => chain.chainId as number),
);

/** Chains exposed by the prepare-only swap surface. Stable 988 is read-only. */
export const ORACLE_SWAP_PREPARE_CHAINS: readonly OracleChain[] = Object.freeze(
  ORACLE_CHAINS.filter((chain) => chain.id !== "stable"),
);

export const ORACLE_CHAIN_BY_ID: Readonly<Record<string, OracleChain>> = Object.freeze(
  Object.fromEntries(ORACLE_CHAINS.map((chain) => [chain.id, chain])) as Record<string, OracleChain>,
);
