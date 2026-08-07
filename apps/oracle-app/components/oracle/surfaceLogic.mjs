// Pure surface logic for the public app panes.
//
// No DOM, no localStorage, no wall clock, no randomness. Every function that
// needs "now" or an id takes it as an argument, so the same input always
// produces the same output and `node --test` can assert on it directly.
//
// surfaceStorage.ts is the thin typed shim that owns browser storage and
// event dispatch; everything worth testing lives here.

export const WATCH_CATEGORIES = Object.freeze([
  "price",
  "wallet",
  "risk",
  "execution",
  "security",
  "nft",
  "governance",
  "system",
]);

export const CAMPAIGN_MODES = Object.freeze(["alert", "prepare", "owner_arm"]);
export const MAX_RECEIPTS = 40;

/**
 * Upper bound for a slippage cap that can honestly be called "bound", in basis
 * points. 300 bps (3%) is generous for the venues this app quotes; anything
 * above it is not a protective limit and must not be stamped as one.
 */
export const MAX_SLIPPAGE_BPS = 300;

/** Deterministic JSON: keys sorted at every depth so hashes are stable. */
export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/**
 * SHA-256 over the canonical bytes. WebCrypto exists as a global in both the
 * browser and Node 20+, so there is one code path and no silent fallback that
 * would produce a different id depending on where it ran.
 */
export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a prepare-phase receipt. Prepare-only by construction: txHash and
 * balances are null and there is no field through which a caller could set
 * them, so a prepare receipt can never claim an execution happened.
 */
export async function buildPreparedSwapReceipt(input, { now }) {
  if (typeof now !== "string" || now === "") {
    throw new TypeError("buildPreparedSwapReceipt requires an explicit ISO `now`");
  }
  const prepareHash = input.intentHash ?? (await sha256Hex({ ...input, createdAt: now }));
  const base = {
    phase: "prepare",
    createdAt: now,
    intent: {
      chain: input.chainLabel,
      sell: input.sellSymbol,
      buy: input.buySymbol,
      amount: input.sellAmount,
    },
    route: {
      venue: input.routeLabel ?? "unknown",
      chainId: input.chainId,
      priceImpactPct: input.priceImpactPct,
    },
    decodedAction: {
      type: "swap.prepare",
      sellAmount: input.sellAmount,
      expectedBuyAmount: input.buyAmount,
    },
    /**
     * These are BOUNDARY STAMPS, not evaluated policy. The first three are
     * architectural constants: they restate guarantees this codebase enforces
     * structurally (no key in the browser, prepare-only receipts, signing
     * deferred to a local signer) and are true for every prepare receipt by
     * construction. No engine evaluated them for THIS intent.
     *
     * Only `slippage cap bound` is computed. "Bound" has to mean inside a real
     * range, not merely present: finite alone passed 500 bps (a 5% cap) and
     * -1 bps (nonsense) as if a limit had been checked. A missing cap is null,
     * which also fails, so an absent value can never read as protection.
     */
    boundaryStamps: [
      { name: "browser holds no key", ok: true, kind: "architectural" },
      { name: "prepared only", ok: true, kind: "architectural" },
      { name: "local signer review required", ok: true, kind: "architectural" },
      {
        name: "slippage cap bound",
        ok:
          Number.isFinite(input.slippageBps) &&
          input.slippageBps > 0 &&
          input.slippageBps <= MAX_SLIPPAGE_BPS,
        kind: "evaluated",
      },
    ],
    allowlistHits: ["public prepare plane", "local signer boundary"],
    prepareHash,
    txHash: null,
    balances: null,
  };
  return {
    receiptId: await sha256Hex(base),
    ...base,
    summary: `${input.sellAmount} ${input.sellSymbol} to ${input.buySymbol} on ${input.chainLabel}. Prepared only. No transaction hash.`,
  };
}

export function sortReceipts(list) {
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Newest first, de-duplicated by receiptId, capped so storage cannot grow forever. */
export function mergeReceipt(list, receipt) {
  return [receipt, ...sortReceipts(list).filter((item) => item.receiptId !== receipt.receiptId)]
    .slice(0, MAX_RECEIPTS);
}

export function createCampaign(input, { now, id }) {
  if (typeof now !== "string" || now === "") {
    throw new TypeError("createCampaign requires an explicit ISO `now`");
  }
  if (typeof id !== "string" || id === "") {
    throw new TypeError("createCampaign requires an explicit `id`");
  }
  if (!CAMPAIGN_MODES.includes(input.mode)) {
    throw new TypeError(`unknown campaign mode: ${String(input.mode)}`);
  }
  if (!WATCH_CATEGORIES.includes(input.category)) {
    throw new TypeError(`unknown watch category: ${String(input.category)}`);
  }
  return { id, createdAt: now, updatedAt: now, status: "watching", ...input };
}

export function sortCampaigns(list) {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function mergeCampaign(list, campaign, now) {
  return [
    { ...campaign, updatedAt: now },
    ...sortCampaigns(list).filter((item) => item.id !== campaign.id),
  ];
}

export function applyCampaignStatus(list, id, status, now) {
  return list.map((item) => (item.id === id ? { ...item, status, updatedAt: now } : item));
}

/**
 * Effective status. A campaign past its expiry reads as expired even though
 * the stored record still says "watching" — expiry is time, not a write. An
 * explicitly paused campaign stays paused rather than silently expiring.
 */
export function classifyCampaign(campaign, now) {
  if (campaign.status !== "watching") return campaign.status;
  return Date.parse(campaign.expiresAt) <= now ? "expired" : "watching";
}

export function campaignStats(campaigns, now) {
  return {
    active: campaigns.filter((item) => classifyCampaign(item, now) === "watching").length,
    alert: campaigns.filter((item) => item.mode === "alert").length,
    arm: campaigns.filter((item) => item.mode === "owner_arm").length,
  };
}
