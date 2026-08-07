import { normalizeRfqIntent } from "../../rfq/intent.mjs";
import { requestRfqQuotes } from "../../rfq/sources.mjs";

export function rfqIntent(args = {}, opts = {}) {
  return normalizeRfqIntent(args, opts);
}

export async function rfqQuote(args = {}, opts = {}) {
  const intent = args.intent?.kind === "rfq-intent" ? args.intent : normalizeRfqIntent(args, opts);
  return requestRfqQuotes(intent, opts);
}

export async function rfqHealth() {
  return { ok: true, provider: "rfq", mode: "intent-rfq", execution: "prepare" };
}
