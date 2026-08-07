"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const ORACLE_BLUE = "#7CC4FF";
const HAIRLINE = "rgba(124,196,255,.14)";
const MUTE = "#9FB8D2";
const INK = "#F4F9FE";

type VenueRow = {
  id: string;
  name?: string;
  chain?: string;
  capabilityTier?: string;
  canPrepare?: boolean;
};

type RankedRoute = {
  venue?: string;
  venueId?: string;
  symbol?: string;
  tier?: string;
  capabilityTier?: string;
  costAccounted?: boolean;
  instrument?: string;
  price?: { mantissa?: string; scale?: number } | string | number;
  mid?: { mantissa?: string; scale?: number } | string | number;
  quote?: { mid?: { mantissa?: string; scale?: number } | string | number };
  notes?: string[];
};

type QuoteEnvelope = {
  ticker?: string;
  rankedOn?: string;
  winner?: RankedRoute | null;
  runnersUp?: RankedRoute[];
  ranked?: RankedRoute[];
  bestPreparable?: RankedRoute | null;
  improvementBps?: number | null;
  sourcesAnswered?: number;
  sourcesTried?: number;
  excluded?: { venue?: string; venueId?: string; reason?: string }[];
  darkWindow?: boolean;
  instrumentMix?: string;
};

function fixedToNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object") {
    const o = v as { mantissa?: string | number; scale?: number };
    if (o.mantissa == null || o.scale == null) return null;
    const m = Number(o.mantissa);
    const s = Number(o.scale);
    if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
    return m / 10 ** s;
  }
  return null;
}

function routeMid(r: RankedRoute | null | undefined): string {
  if (!r) return "—";
  const n =
    fixedToNumber(r.quote?.mid) ??
    fixedToNumber(r.mid) ??
    fixedToNumber(r.price);
  if (n == null) return "—";
  if (Math.abs(n) >= 100) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return n.toExponential(2);
}

function routeVenue(r: RankedRoute | null | undefined): string {
  return r?.venue || r?.venueId || "none";
}

function routeTier(r: RankedRoute | null | undefined): string {
  return r?.tier || r?.capabilityTier || "—";
}

function readPortfolioWallet(): string {
  if (typeof window === "undefined") return "";
  try {
    return (localStorage.getItem("oracle-portfolio-evm") || "").trim();
  } catch {
    return "";
  }
}

/**
 * Crossbook product pane.
 *
 * Separate protocol product (on-chain / tokenized equities best execution),
 * shipped inside the Oracle app. Shares the same package module the CLI and
 * MCP use. Prepare-only: quote-only venues never look signable here.
 */
export function CrossbookPane() {
  const [ticker, setTicker] = useState("NVDA");
  const [sizeUsd, setSizeUsd] = useState("1000");
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [quote, setQuote] = useState<QuoteEnvelope | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [preparePhase, setPreparePhase] = useState<"idle" | "working" | "done" | "failed">("idle");
  const [prepared, setPrepared] = useState<unknown>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  useEffect(() => {
    setRecipient(readPortfolioWallet());
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/oracle/equities/venues", { cache: "no-store" });
        const body = (await res.json()) as { venues?: VenueRow[] };
        if (!cancelled && Array.isArray(body.venues)) setVenues(body.venues);
      } catch {
        // inventory is optional chrome; quote path is authoritative
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const canQuote = useMemo(() => {
    const t = ticker.trim();
    const s = Number(sizeUsd);
    return t.length >= 1 && Number.isFinite(s) && s > 0;
  }, [ticker, sizeUsd]);

  const runQuote = useCallback(async () => {
    if (!canQuote) return;
    setPhase("loading");
    setError(null);
    setPrepared(null);
    setPreparePhase("idle");
    setPrepareError(null);
    try {
      const q = new URLSearchParams({
        ticker: ticker.trim().toUpperCase(),
        size: String(Number(sizeUsd)),
      });
      const res = await fetch(`/api/oracle/equities/quote?${q}`, { cache: "no-store" });
      const body = (await res.json()) as { quote?: QuoteEnvelope; error?: string };
      if (body.error && !body.quote) {
        setError(body.error);
        setQuote(null);
        setPhase("failed");
        return;
      }
      setQuote(body.quote || null);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "quote failed");
      setQuote(null);
      setPhase("failed");
    }
  }, [canQuote, ticker, sizeUsd]);

  const canPrepare = useMemo(() => {
    return Boolean(quote?.bestPreparable) && /^0x[a-fA-F0-9]{40}$/.test(recipient.trim());
  }, [quote, recipient]);

  const runPrepare = useCallback(async () => {
    if (!canPrepare) return;
    setPreparePhase("working");
    setPrepareError(null);
    setPrepared(null);
    try {
      const res = await fetch("/api/oracle/equities/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticker: ticker.trim().toUpperCase(),
          recipient: recipient.trim(),
          sizeUsd: Number(sizeUsd),
        }),
      });
      const body = (await res.json()) as {
        prepared?: unknown;
        error?: string | null;
        requiresWalletSignature?: boolean;
        backendSigner?: boolean;
      };
      if (body.error || !body.prepared) {
        setPrepareError(body.error || "prepare returned empty");
        setPreparePhase("failed");
        return;
      }
      if (body.backendSigner !== false || body.requiresWalletSignature !== true) {
        setPrepareError("prepare response lost custody posture flags");
        setPreparePhase("failed");
        return;
      }
      setPrepared(body.prepared);
      setPreparePhase("done");
    } catch (e) {
      setPrepareError(e instanceof Error ? e.message : "prepare failed");
      setPreparePhase("failed");
    }
  }, [canPrepare, ticker, recipient, sizeUsd]);

  const rows = quote?.ranked?.length ? quote.ranked : quote?.winner ? [quote.winner, ...(quote.runnersUp || [])] : [];

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-2 border-b pb-5" style={{ borderColor: HAIRLINE }}>
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.2em]" style={{ color: ORACLE_BLUE }}>
            Product
          </span>
          <h1 className="fable-display text-[1.8rem] leading-none tracking-tight" style={{ color: INK }}>
            Crossbook
          </h1>
        </div>
        <p className="max-w-[58ch] text-[0.78rem] leading-relaxed" style={{ color: MUTE }}>
          Crossbook is a separate Oracle product for on-chain equities best execution. Compares HIP-3 builder DEXes,
          Arcus, RH Uniswap on 4663, Solana xStocks, and TON ston.fi. Discovery ranks freely;
          only RH Uniswap can prepare an unsigned swap for your wallet to sign.
        </p>
        <div className="mt-1 flex flex-wrap gap-2 font-mono-ui text-[0.52rem] uppercase tracking-[0.14em]" style={{ color: MUTE }}>
          <span className="rounded-full border px-2 py-1" style={{ borderColor: HAIRLINE }}>browser · no keys</span>
          <span className="rounded-full border px-2 py-1" style={{ borderColor: HAIRLINE }}>action · prepare</span>
          <span className="rounded-full border px-2 py-1" style={{ borderColor: HAIRLINE }}>cli · oracle equities</span>
        </div>
      </header>

      {venues.length > 0 && (
        <section aria-label="Venue inventory" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {venues.map((v) => (
            <div
              key={v.id}
              className="rounded-lg border px-3 py-3"
              style={{ borderColor: HAIRLINE, background: "rgba(17,25,37,.45)" }}
            >
              <div className="font-mono-ui text-[0.58rem] uppercase tracking-[0.12em]" style={{ color: ORACLE_BLUE }}>
                {v.id}
              </div>
              <div className="mt-1 text-[0.85rem]" style={{ color: INK }}>
                {v.name || v.id}
              </div>
              <div className="mt-1 font-mono-ui text-[0.55rem]" style={{ color: MUTE }}>
                {v.chain || "—"} · {v.capabilityTier || (v.canPrepare ? "prepare" : "quote-only")}
              </div>
            </div>
          ))}
        </section>
      )}

      <section
        aria-label="Quote form"
        className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_1fr_auto]"
        style={{ borderColor: HAIRLINE, background: "rgba(17,25,37,.35)" }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em]" style={{ color: MUTE }}>
            Ticker
          </span>
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            className="rounded-md border bg-transparent px-3 py-2 font-mono-ui text-[0.9rem] outline-none"
            style={{ borderColor: HAIRLINE, color: INK }}
            placeholder="NVDA"
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em]" style={{ color: MUTE }}>
            Size USD
          </span>
          <input
            value={sizeUsd}
            onChange={(e) => setSizeUsd(e.target.value)}
            className="rounded-md border bg-transparent px-3 py-2 font-mono-ui text-[0.9rem] outline-none"
            style={{ borderColor: HAIRLINE, color: INK }}
            inputMode="decimal"
          />
        </label>
        <div className="flex items-end">
          <button
            type="button"
            disabled={!canQuote || phase === "loading"}
            onClick={() => void runQuote()}
            className="w-full rounded-md px-4 py-2.5 font-mono-ui text-[0.62rem] uppercase tracking-[0.16em] disabled:opacity-40 sm:w-auto"
            style={{ background: ORACLE_BLUE, color: "#071018" }}
          >
            {phase === "loading" ? "Quoting…" : "Get quote"}
          </button>
        </div>
      </section>

      {error && (
        <p className="text-[0.78rem]" style={{ color: "#FF8B8B" }} role="alert">
          {error}
        </p>
      )}

      {quote && phase === "ready" && (
        <section aria-label="Ranked routes" className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-4" style={{ borderColor: HAIRLINE }}>
              <div className="font-mono-ui text-[0.52rem] uppercase tracking-[0.16em]" style={{ color: MUTE }}>
                Winner · discovery
              </div>
              <div className="mt-2 text-[1.1rem]" style={{ color: INK }}>
                {routeVenue(quote.winner)}
              </div>
              <div className="mt-1 font-mono-ui text-[0.72rem]" style={{ color: ORACLE_BLUE }}>
                mid {routeMid(quote.winner)} · tier {routeTier(quote.winner)}
              </div>
              <p className="mt-2 text-[0.7rem] leading-relaxed" style={{ color: MUTE }}>
                Ranked on {quote.rankedOn || "gross"}. A quote-only winner is not signable here.
              </p>
            </div>
            <div className="rounded-lg border p-4" style={{ borderColor: HAIRLINE }}>
              <div className="font-mono-ui text-[0.52rem] uppercase tracking-[0.16em]" style={{ color: MUTE }}>
                Best preparable
              </div>
              <div className="mt-2 text-[1.1rem]" style={{ color: INK }}>
                {routeVenue(quote.bestPreparable)}
              </div>
              <div className="mt-1 font-mono-ui text-[0.72rem]" style={{ color: ORACLE_BLUE }}>
                mid {routeMid(quote.bestPreparable)} · only RH Uniswap prepares
              </div>
              <p className="mt-2 text-[0.7rem] leading-relaxed" style={{ color: MUTE }}>
                {quote.darkWindow
                  ? "Dark window: outside NYSE core hours, marks are not real price discovery."
                  : "Independent of the discovery winner."}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: HAIRLINE }}>
            <table className="w-full min-w-[560px] border-collapse text-left text-[0.75rem]">
              <thead>
                <tr className="font-mono-ui text-[0.52rem] uppercase tracking-[0.14em]" style={{ color: MUTE }}>
                  <th className="border-b px-3 py-2" style={{ borderColor: HAIRLINE }}>Venue</th>
                  <th className="border-b px-3 py-2" style={{ borderColor: HAIRLINE }}>Mid</th>
                  <th className="border-b px-3 py-2" style={{ borderColor: HAIRLINE }}>Tier</th>
                  <th className="border-b px-3 py-2" style={{ borderColor: HAIRLINE }}>Costs</th>
                  <th className="border-b px-3 py-2" style={{ borderColor: HAIRLINE }}>Instrument</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${routeVenue(r)}-${i}`} style={{ color: INK }}>
                    <td className="border-b px-3 py-2 font-mono-ui" style={{ borderColor: HAIRLINE }}>
                      {routeVenue(r)}
                    </td>
                    <td className="border-b px-3 py-2 font-mono-ui" style={{ borderColor: HAIRLINE }}>
                      {routeMid(r)}
                    </td>
                    <td className="border-b px-3 py-2" style={{ borderColor: HAIRLINE, color: MUTE }}>
                      {routeTier(r)}
                    </td>
                    <td className="border-b px-3 py-2" style={{ borderColor: HAIRLINE, color: MUTE }}>
                      {r.costAccounted ? "accounted" : "unmeasured"}
                    </td>
                    <td className="border-b px-3 py-2" style={{ borderColor: HAIRLINE, color: MUTE }}>
                      {r.instrument || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_auto]"
            style={{ borderColor: HAIRLINE, background: "rgba(17,25,37,.35)" }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em]" style={{ color: MUTE }}>
                Recipient wallet (signs outside this app)
              </span>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
                className="rounded-md border bg-transparent px-3 py-2 font-mono-ui text-[0.8rem] outline-none"
                style={{ borderColor: HAIRLINE, color: INK }}
                placeholder="0x…"
                spellCheck={false}
              />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                disabled={!canPrepare || preparePhase === "working" || !quote.bestPreparable}
                onClick={() => void runPrepare()}
                className="w-full rounded-md border px-4 py-2.5 font-mono-ui text-[0.62rem] uppercase tracking-[0.16em] disabled:opacity-40 sm:w-auto"
                style={{ borderColor: ORACLE_BLUE, color: ORACLE_BLUE }}
              >
                {preparePhase === "working" ? "Preparing…" : "Prepare RH path"}
              </button>
            </div>
            {!quote.bestPreparable && (
              <p className="sm:col-span-2 text-[0.7rem]" style={{ color: MUTE }}>
                No preparable venue for this ticker in the current inventory.
              </p>
            )}
            {quote.bestPreparable && !canPrepare && (
              <p className="sm:col-span-2 text-[0.7rem]" style={{ color: MUTE }}>
                Set a real 0x recipient (Portfolio wallet is used when present) to enable prepare.
              </p>
            )}
            {prepareError && (
              <p className="sm:col-span-2 text-[0.75rem]" style={{ color: "#FF8B8B" }} role="alert">
                {prepareError}
              </p>
            )}
            {preparePhase === "done" && prepared != null && (
              <pre
                className="sm:col-span-2 max-h-64 overflow-auto rounded-md border p-3 font-mono-ui text-[0.65rem] leading-relaxed"
                style={{ borderColor: HAIRLINE, color: MUTE, background: "rgba(0,0,0,.25)" }}
              >
                {JSON.stringify(prepared, null, 2)}
              </pre>
            )}
          </div>
        </section>
      )}

      <footer className="border-t pt-4 text-[0.68rem] leading-relaxed" style={{ borderColor: HAIRLINE, color: MUTE }}>
        Crossbook is a separate product surface inside Oracle, not a private desk feature. CLI parity:{" "}
        <code className="font-mono-ui text-[0.66rem]" style={{ color: ORACLE_BLUE }}>
          oracle equities quote {ticker.trim().toUpperCase() || "NVDA"} --size {sizeUsd || "1000"}
        </code>
        . Same module powers MCP <code className="font-mono-ui">equity_quote</code>. This app never holds keys,
        never signs, never broadcasts.
      </footer>
    </div>
  );
}
