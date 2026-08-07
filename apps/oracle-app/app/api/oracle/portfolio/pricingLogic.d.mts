// Types for the pure pricing module.
//
// The logic lives in .mjs so a node:test golden master can import it directly
// without a build step. This declaration keeps the route fully typed.

export interface PricedRow {
  id: string;
  chainId: string;
  chainNumericId: number | null;
  kind: string;
  symbol: string | null;
  amount: string | null;
  decimals: number | null;
  valueUsd: string | null;
  priced: boolean;
  address: string | null;
  collection: string | null;
  suspect?: boolean;
  suspectReason?: string;
}

export declare const LLAMA_CHAIN_NAMESPACES: Record<number, string>;
export declare const NATIVE_PRICE_KEYS: Record<number, string>;
export declare const MAX_ROWS_PER_CHAIN: number;
export declare const IMPLAUSIBLE_ROW_USD: number;
export declare const CONCENTRATION_WARN_RATIO: number;

export declare function stringValue(value: unknown): string | null;
export declare function priceKeyForRow(row: PricedRow): string | null;
export declare function decimalAmount(amount: string | null, decimals: number | null): number | null;
export declare function prunedRows<T>(rows: T[]): { rows: T[]; dropped: number };
export declare function valueRows<T extends PricedRow>(rows: T[], prices: Map<string, number>): T[];
export declare function flagImplausible<T extends PricedRow>(rows: T[]): { rows: T[]; suspectCount: number };
export declare function knownValue(rows: PricedRow[]): string | null;
export declare function concentration(rows: PricedRow[]): { ratio: number; concentrated: boolean } | null;
export declare function cappedRows<T extends PricedRow>(rows: T[], maxPerChain?: number): { rows: T[]; truncated: number };
