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
export declare const ORACLE_DATA_PLANE: {
    readonly defaultBaseUrl: "http://127.0.0.1:8787";
    readonly identity: {
        readonly service: "oracle";
        readonly plane: "data+onboard";
        readonly exec: false;
    };
    readonly routes: {
        readonly health: {
            readonly id: "health";
            readonly method: "GET";
            readonly path: "/api/oracle/status";
            readonly upstreamPath: "/health";
        };
        readonly catalog: {
            readonly id: "catalog";
            readonly method: "GET";
            readonly path: "/api/oracle/catalog";
            readonly upstreamPath: "/data/catalog";
        };
        readonly providerHealth: {
            readonly id: "providerHealth";
            readonly method: "GET";
            readonly path: "/api/oracle/health";
            readonly upstreamPath: "/data/health";
        };
        readonly portfolio: {
            readonly id: "portfolio";
            readonly method: "GET";
            readonly path: "/api/oracle/portfolio";
            readonly upstreamPath: "/public/portfolio";
        };
        readonly nfts: {
            readonly id: "nfts";
            readonly method: "GET";
            readonly path: "/api/oracle/nfts";
            readonly upstreamPath: "/public/nfts";
        };
        readonly approvals: {
            readonly id: "approvals";
            readonly method: "GET";
            readonly path: "/api/oracle/approvals";
            readonly upstreamPath: "/public/approvals";
        };
    };
};
export declare const ORACLE_SIGNER_CONTRACT: {
    readonly loopbackOnly: true;
    readonly routes: {
        readonly status: {
            readonly id: "signer.status";
            readonly method: "GET";
            readonly path: "/api/oracle/signer";
            readonly upstreamPath: "/health";
        };
        readonly prepareSwap: {
            readonly id: "swap.prepare";
            readonly method: "POST";
            readonly path: "/api/oracle/swap/prepare";
            readonly upstreamPath: "/swap/prepare";
        };
        readonly prepareRevoke: {
            readonly id: "revoke.prepare";
            readonly method: "POST";
            readonly path: "/api/oracle/revoke/prepare";
            readonly upstreamPath: "/revoke/prepare";
        };
    };
};
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
export type OracleApprovalRisk = "operator-all" | "unlimited" | "stale" | "unknown-spender" | "scoped";
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
export declare const ORACLE_UNLIMITED_FLOOR: bigint;
/** An approval untouched for this long is surfaced as stale. */
export declare const ORACLE_STALE_AFTER_MS: number;
/** Risk tiers, most severe first. Order is the display and sort order. */
export declare const ORACLE_APPROVAL_RISKS: readonly OracleApprovalRisk[];
/**
 * Classify one approval.
 *
 * An ERC-721 operator grant is not an amount at all — it is control of every
 * item in the collection — so it outranks `unlimited`, which is still bounded
 * by a single token's balance.
 */
export declare function oracleApprovalRisk(input: {
    standard: OracleApprovalStandard;
    unlimited: boolean;
    spenderLabel: string | null;
    lastActivityAt: string | null;
}): OracleApprovalRisk;
/** Render an allowance for display. Operator grants have no amount. */
export declare function oracleAllowanceDisplay(raw: bigint | null, decimals: number | null, standard: OracleApprovalStandard): string;
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
export declare const ORACLE_CHAINS: readonly OracleChain[];
export declare const ORACLE_EVM_CHAIN_IDS: readonly number[];
/** Chains exposed by the prepare-only swap surface. Stable 988 is read-only. */
export declare const ORACLE_SWAP_PREPARE_CHAINS: readonly OracleChain[];
export declare const ORACLE_CHAIN_BY_ID: Readonly<Record<string, OracleChain>>;
//# sourceMappingURL=index.d.ts.map