import {
  MAX_RECEIPTS,
  applyCampaignStatus,
  buildPreparedSwapReceipt as buildReceipt,
  campaignStats as computeStats,
  classifyCampaign as classify,
  createCampaign as makeCampaign,
  mergeCampaign,
  mergeReceipt,
  sortCampaigns,
  sortReceipts,
  WATCH_CATEGORIES as CATEGORIES,
} from "./surfaceLogic.mjs";

export type ReceiptPhase = "prepare" | "execute";
export type CampaignMode = "alert" | "prepare" | "owner_arm";
export type CampaignStatus = "watching" | "expired" | "paused";
export type WatchCategory =
  | "price"
  | "wallet"
  | "risk"
  | "execution"
  | "security"
  | "nft"
  | "governance"
  | "system";

export interface OracleReceipt {
  receiptId: string;
  phase: ReceiptPhase;
  createdAt: string;
  intent: Record<string, string | number | null>;
  route: Record<string, string | number | null>;
  decodedAction: Record<string, string | number | null>;
  boundaryStamps: { name: string; ok: boolean; kind: "architectural" | "evaluated" }[];
  allowlistHits: string[];
  prepareHash: string;
  txHash: string | null;
  balances: { before: Record<string, string>; after: Record<string, string> } | null;
  summary: string;
}

export interface OracleCampaign {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: CampaignStatus;
  category: WatchCategory;
  label: string;
  trigger: string;
  exactAction: string;
  mode: CampaignMode;
  expiresAt: string;
  notify: boolean;
}

export interface PreparedSwapInput {
  chainLabel: string;
  chainId: string;
  sellSymbol: string;
  buySymbol: string;
  sellAmount: string;
  buyAmount: string;
  routeLabel: string | null;
  priceImpactPct: number | null;
  slippageBps: number | null;
  intentHash: string | null;
}

export const WATCH_CATEGORIES = CATEGORIES as readonly WatchCategory[];
export { MAX_RECEIPTS };

const RECEIPTS_KEY = "oracle.actionReceipts.v1";
const CAMPAIGNS_KEY = "oracle.campaigns.v1";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readArray<T>(key: string): T[] {
  const s = storage();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeArray<T>(key: string, value: T[]) {
  const s = storage();
  if (!s) return;
  s.setItem(key, JSON.stringify(value));
}

function announce(event: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(event));
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `campaign-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function listReceipts(): OracleReceipt[] {
  return sortReceipts(readArray<OracleReceipt>(RECEIPTS_KEY)) as OracleReceipt[];
}

export function saveReceipt(receipt: OracleReceipt): OracleReceipt[] {
  const next = mergeReceipt(listReceipts(), receipt) as OracleReceipt[];
  writeArray(RECEIPTS_KEY, next);
  announce("oracle-receipts-updated");
  return next;
}

export function buildPreparedSwapReceipt(input: PreparedSwapInput): Promise<OracleReceipt> {
  return buildReceipt(input, { now: new Date().toISOString() }) as Promise<OracleReceipt>;
}

export function listCampaigns(): OracleCampaign[] {
  return sortCampaigns(readArray<OracleCampaign>(CAMPAIGNS_KEY)) as OracleCampaign[];
}

export function saveCampaign(campaign: OracleCampaign): OracleCampaign[] {
  const next = mergeCampaign(listCampaigns(), campaign, new Date().toISOString()) as OracleCampaign[];
  writeArray(CAMPAIGNS_KEY, next);
  announce("oracle-campaigns-updated");
  return next;
}

export function updateCampaignStatus(id: string, status: CampaignStatus): OracleCampaign[] {
  const next = applyCampaignStatus(
    listCampaigns(),
    id,
    status,
    new Date().toISOString(),
  ) as OracleCampaign[];
  writeArray(CAMPAIGNS_KEY, next);
  announce("oracle-campaigns-updated");
  return next;
}

export function createCampaign(
  input: Omit<OracleCampaign, "id" | "createdAt" | "updatedAt" | "status">,
): OracleCampaign {
  return makeCampaign(input, { now: new Date().toISOString(), id: newId() }) as OracleCampaign;
}

export function classifyCampaign(campaign: OracleCampaign, now: number): CampaignStatus {
  return classify(campaign, now) as CampaignStatus;
}

export function campaignStats(
  campaigns: OracleCampaign[],
  now: number,
): { active: number; alert: number; arm: number } {
  return computeStats(campaigns, now);
}
