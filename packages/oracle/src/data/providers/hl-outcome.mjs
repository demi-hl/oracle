// HIP-4 outcome market prepare helpers (local, no VPS).
import { stampPrepared } from "../../prepare-envelope.mjs";
import { hlOutcomeMeta } from "./hl-info.mjs";
import { outcomeAssetId, parseOutcomeCoin } from "./hl-assets.mjs";
import { hlPreparePerpOrder, hlPrepareCancelOrder } from "./hl-perps.mjs";

export async function hlOutcomeList(opts = {}) {
  const meta = await hlOutcomeMeta(opts);
  return {
    provider: "hl-outcome",
    kind: "outcome-meta",
    outcomes: meta?.outcomes || [],
    questions: meta?.questions || [],
  };
}

/**
 * Prepare a HIP-4 outcome order.
 * args: { outcome, side: 0|1|'yes'|'no', sideName?, coin?, ...hlPreparePerpOrder fields }
 */
export async function hlPrepareOutcomeOrder(args = {}, opts = {}) {
  let coin = args.coin;
  let outcome = args.outcome;
  let side = args.side;
  if (typeof side === "string") {
    const s = side.toLowerCase();
    if (s === "yes" || s === "0") side = 0;
    else if (s === "no" || s === "1") side = 1;
  }
  if (args.sideName && outcome != null) {
    const meta = await hlOutcomeMeta(opts);
    const o = (meta?.outcomes || []).find((x) => Number(x.outcome) === Number(outcome));
    if (o?.sideSpecs) {
      const idx = o.sideSpecs.findIndex(
        (sp) => String(sp.name).toLowerCase() === String(args.sideName).toLowerCase()
      );
      if (idx >= 0) side = idx;
    }
  }
  if (!coin) {
    if (outcome == null || side == null) {
      throw new Error("hl-outcome: provide coin (#N) or outcome + side (0/1 or yes/no)");
    }
    coin = outcomeAssetId(outcome, side).coin;
  }
  const prepared = await hlPreparePerpOrder({ ...args, coin }, opts);
  // ensure stamped kind
  return stampPrepared(
    { ...prepared, kind: "hip4-order", provider: "hl-perps" },
    { provider: "hl-perps", kind: "hip4-order" }
  );
}

export async function hlPrepareOutcomeCancel(args = {}, opts = {}) {
  let coin = args.coin;
  if (!coin && args.outcome != null) {
    const side = args.side ?? 0;
    coin = outcomeAssetId(args.outcome, side).coin;
  }
  return hlPrepareCancelOrder({ ...args, coin }, opts);
}
