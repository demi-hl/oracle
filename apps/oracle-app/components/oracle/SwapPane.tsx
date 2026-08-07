"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ORACLE_SIGNER_CONTRACT,
  ORACLE_SWAP_PREPARE_CHAINS,
  type OracleChain,
  type OracleSignerStatus,
  type OracleSwapPrepareResponse,
} from "@oracle-agent/contract";
import { haptic } from "@/components/shell/haptics";
import { buildPreparedSwapReceipt, saveReceipt } from "./surfaceStorage";

const ORACLE_BLUE = "#7CC4FF";
const ORACLE_INK = "#F4F9FE";
const ORACLE_MUTE = "#9FB8D2";
const HAIRLINE = "rgba(124,196,255,.14)";
const EASE = [0.16, 1, 0.3, 1] as const;

const GUARDRAILS = [
  { label: "browser", value: "no keys" },
  { label: "action", value: "prepare" },
  { label: "execution", value: "local signer" },
];

type SwapPhase = "idle" | "quoting" | "review" | "failed";

interface SwapQuote {
  sellSymbol: string;
  buySymbol: string;
  sellAmount: string;
  buyAmount: string;
  buyAmountFormatted?: string | null;
  rate: string | null;
  routeLabel: string | null;
  priceImpactPct: number | null;
  slippageBps: number | null;
  expiresAt: string | null;
  intentHash: string | null;
}

type SwapPrepareEnvelope = OracleSwapPrepareResponse<SwapQuote>;

function shortHash(value: string | null): string {
  if (!value) return "none";
  const trimmed = value.trim();
  if (trimmed.length <= 14) return trimmed;
  return trimmed.slice(0, 8) + "\u2026" + trimmed.slice(-4);
}

function formatAmount(value: string | null): string {
  if (value === null || value.trim() === "") return "\u2014";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n === 0) return "0";
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/**
 * Purely presentational route preview. It does not represent signing,
 * submission, or settlement.
 */
function SwapRoutePreview({
  sellSymbol,
  buySymbol,
  sellAccent,
  buyAccent,
}: {
  sellSymbol: string;
  buySymbol: string;
  sellAccent: string;
  buyAccent: string;
}) {
  return (
    <div
      className="relative h-[104px] w-full overflow-hidden rounded-lg border"
      style={{ borderColor: HAIRLINE, background: "rgba(17,25,37,.55)" }}
      role="img"
      aria-label={
        "Swap route preview, " + sellSymbol + " to " + buySymbol
      }
    >
      <div
        aria-hidden
        className="absolute left-0 right-0 top-1/2 h-px"
        style={{ background: HAIRLINE }}
      />

      <motion.div
        className="absolute inset-0 flex items-center justify-between px-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.24, ease: EASE }}
      >
        <div className="flex flex-col items-center gap-1">
            <span
              className="grid h-11 w-11 place-items-center rounded-full border font-mono-ui text-[0.7rem]"
              style={{ borderColor: sellAccent, color: sellAccent }}
            >
              {sellSymbol.slice(0, 4)}
            </span>
            <span className="font-mono-ui text-[0.6rem] tracking-[0.14em]" style={{ color: ORACLE_MUTE }}>
              OUT
            </span>
        </div>

        <div
          aria-hidden
          className="mx-4 h-px flex-1"
          style={{
            background: "linear-gradient(90deg, " + sellAccent + "44, " + buyAccent + "aa)",
          }}
        />

        <div className="flex flex-col items-center gap-1">
            <span
              className="grid h-11 w-11 place-items-center rounded-full border font-mono-ui text-[0.7rem]"
              style={{
                borderColor: buyAccent,
                color: buyAccent,
              }}
            >
              {buySymbol.slice(0, 4)}
            </span>
            <span className="font-mono-ui text-[0.6rem] tracking-[0.14em]" style={{ color: ORACLE_MUTE }}>
              IN
            </span>
        </div>
      </motion.div>
    </div>
  );
}

function Guardrail({ label, value }: (typeof GUARDRAILS)[number]) {
  return (
    <div className="border p-3" style={{ borderColor: HAIRLINE, background: "rgba(124,196,255,.025)" }}>
      <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.16em]" style={{ color: ORACLE_MUTE }}>{label}</div>
      <div className="mt-1 font-mono-ui text-[0.66rem] uppercase tracking-[0.14em]" style={{ color: ORACLE_BLUE }}>{value}</div>
    </div>
  );
}

export function SwapPane() {
  const [chainId, setChainId] = useState<string>(ORACLE_SWAP_PREPARE_CHAINS[0]?.id ?? "ethereum");
  const [sellSymbol, setSellSymbol] = useState("");
  const [buySymbol, setBuySymbol] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [phase, setPhase] = useState<SwapPhase>("idle");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signer, setSigner] = useState<OracleSignerStatus | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const chain: OracleChain | undefined = useMemo(
    () => ORACLE_SWAP_PREPARE_CHAINS.find((c) => c.id === chainId),
    [chainId],
  );
  const accent = chain?.accent ?? ORACLE_BLUE;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(ORACLE_SIGNER_CONTRACT.routes.status.path, {
          cache: "no-store",
          signal: controller.signal,
        });
        const json = (await res.json()) as OracleSignerStatus;
        if (!cancelled) setSigner(json);
      } catch {
        if (!cancelled) {
          setSigner({
            configured: false,
            reachable: false,
            armed: false,
            surfaces: [],
            error: "Signer status unavailable",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Same key the Portfolio and Approvals panes read. A prepared transaction is
  // built FOR an address, so without it the desk cannot produce calldata and
  // every quote fails. This pane previously never sent one.
  const [ownerEvm, setOwnerEvm] = useState("");
  useEffect(() => {
    setOwnerEvm(window.localStorage.getItem("oracle-portfolio-evm") ?? "");
  }, []);

  const canQuote =
    sellSymbol.trim() !== "" &&
    buySymbol.trim() !== "" &&
    Number(sellAmount) > 0 &&
    /^0x[a-fA-F0-9]{40}$/.test(ownerEvm.trim());

  const requestQuote = useCallback(async () => {
    if (!canQuote) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("quoting");
    setError(null);
    setQuote(null);
    void haptic(6);

    try {
      const res = await fetch(ORACLE_SIGNER_CONTRACT.routes.prepareSwap.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          chainId,
          sellSymbol: sellSymbol.trim(),
          buySymbol: buySymbol.trim(),
          sellAmount: sellAmount.trim(),
          taker: ownerEvm.trim(),
        }),
      });
      const json = (await res.json()) as SwapPrepareEnvelope;
      if (controller.signal.aborted) return;
      if (!json.configured || !json.reachable || !json.quote) {
        setError(json.error ?? "Oracle swap preparation is unavailable");
        setPhase("failed");
        return;
      }
      setQuote(json.quote);
      void buildPreparedSwapReceipt({
        chainLabel: ORACLE_SWAP_PREPARE_CHAINS.find((c) => c.id === chainId)?.label ?? chainId,
        chainId,
        sellSymbol: json.quote.sellSymbol,
        buySymbol: json.quote.buySymbol,
        sellAmount: json.quote.sellAmount,
        buyAmount: json.quote.buyAmount,
        routeLabel: json.quote.routeLabel,
        priceImpactPct: json.quote.priceImpactPct,
        slippageBps: json.quote.slippageBps,
        intentHash: json.quote.intentHash,
      }).then(saveReceipt).catch(() => undefined);
      setPhase("review");
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Swap preparation failed");
      setPhase("failed");
    }
  }, [canQuote, chainId, sellSymbol, buySymbol, sellAmount, ownerEvm]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setPhase("idle");
    setQuote(null);
    setError(null);
  }, []);

  const signerLine = !signer
    ? "Checking signer"
    : !signer.configured
      ? "Signer not configured. Run oracle-signer on this machine to enable execution."
      : !signer.reachable
        ? "Signer configured but unreachable on loopback."
        : signer.armed
          ? "Signer armed. Surfaces: " + (signer.surfaces.join(", ") || "none")
          : "Signer reachable but disarmed. Arm it on the signer host, not from this app.";

  return (
    <section className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[1.35rem]" style={{ color: ORACLE_INK, fontFamily: "var(--theme-font-display)" }}>
            Swap
          </h2>
          <p className="font-mono-ui text-[0.66rem] tracking-[0.16em]" style={{ color: ORACLE_MUTE }}>
            ORACLE PREPARES. THE SIGNER HOLDS THE KEY.
          </p>
        </div>
        <span
          className="rounded-full border px-3 py-1 font-mono-ui text-[0.6rem] tracking-[0.16em]"
          style={{
            borderColor: HAIRLINE,
            color: signer?.armed ? accent : ORACLE_MUTE,
          }}
        >
          {signer?.armed ? "ARMED" : "DISARMED"}
        </span>
      </header>

      <p className="text-[0.78rem]" style={{ color: ORACLE_MUTE }}>
        {signerLine}
      </p>

      <div className="grid gap-px overflow-hidden border sm:grid-cols-3" style={{ borderColor: HAIRLINE, background: HAIRLINE }}>
        {GUARDRAILS.map((item) => <Guardrail key={item.label} {...item} />)}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Select chain">
        {ORACLE_SWAP_PREPARE_CHAINS.map((c) => {
          const on = c.id === chainId;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setChainId(c.id);
                reset();
              }}
              className="rounded-full border px-3 py-1 font-mono-ui text-[0.62rem] tracking-[0.12em] transition-colors"
              style={{
                borderColor: on ? c.accent : HAIRLINE,
                color: on ? c.accent : ORACLE_MUTE,
                background: on ? c.accent + "14" : "transparent",
              }}
              aria-pressed={on}
            >
              {c.shortLabel.toUpperCase()}
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono-ui text-[0.6rem] tracking-[0.16em]" style={{ color: ORACLE_MUTE }}>
            SELL
          </span>
          <input
            value={sellSymbol}
            onChange={(e) => setSellSymbol(e.target.value)}
            placeholder={chain?.nativeSymbol ?? "ETH"}
            spellCheck={false}
            className="rounded-md border bg-transparent px-3 py-2 text-[0.9rem] outline-none"
            style={{ borderColor: HAIRLINE, color: ORACLE_INK }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono-ui text-[0.6rem] tracking-[0.16em]" style={{ color: ORACLE_MUTE }}>
            BUY
          </span>
          <input
            value={buySymbol}
            onChange={(e) => setBuySymbol(e.target.value)}
            placeholder="USDC"
            spellCheck={false}
            className="rounded-md border bg-transparent px-3 py-2 text-[0.9rem] outline-none"
            style={{ borderColor: HAIRLINE, color: ORACLE_INK }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono-ui text-[0.6rem] tracking-[0.16em]" style={{ color: ORACLE_MUTE }}>
            AMOUNT
          </span>
          <input
            value={sellAmount}
            onChange={(e) => setSellAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.0"
            spellCheck={false}
            className="rounded-md border bg-transparent px-3 py-2 font-mono-ui text-[0.9rem] outline-none"
            style={{ borderColor: HAIRLINE, color: ORACLE_INK }}
          />
        </label>
      </div>

      <SwapRoutePreview
        sellSymbol={sellSymbol.trim() || (chain?.nativeSymbol ?? "ETH")}
        buySymbol={buySymbol.trim() || "USDC"}
        sellAccent={accent}
        buyAccent={ORACLE_BLUE}
      />

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={requestQuote}
          disabled={!canQuote || phase === "quoting"}
          className="rounded-md border px-4 py-2 font-mono-ui text-[0.66rem] tracking-[0.16em] disabled:opacity-40"
          style={{ borderColor: accent, color: accent }}
        >
          {phase === "quoting" ? "QUOTING" : "GET QUOTE"}
        </button>
        {phase !== "idle" && (
          <button
            type="button"
            onClick={reset}
            className="rounded-md border px-4 py-2 font-mono-ui text-[0.66rem] tracking-[0.16em]"
            style={{ borderColor: HAIRLINE, color: ORACLE_MUTE }}
          >
            RESET
          </button>
        )}
      </div>

      {!/^0x[a-fA-F0-9]{40}$/.test(ownerEvm.trim()) && (
        <p className="mt-3 font-mono-ui text-[0.6rem] tracking-[0.14em]" style={{ color: ORACLE_MUTE }}>
          ADD AN EVM ADDRESS IN PORTFOLIO TO QUOTE. A PREPARED SWAP IS BUILT FOR THE WALLET THAT SIGNS IT.
        </p>
      )}

      {error !== null && (
        <p
          role="status"
          className="rounded-md border px-3 py-2 text-[0.78rem]"
          style={{ borderColor: "rgba(255,99,87,.35)", color: "#FF6357" }}
        >
          {error}
        </p>
      )}

      {quote !== null && (
        <dl
          className="grid gap-2 rounded-none border p-4 text-[0.8rem] sm:grid-cols-2"
          style={{ borderColor: HAIRLINE, color: ORACLE_INK }}
        >
          <div className="mb-2 border-b pb-3 sm:col-span-2" style={{ borderColor: HAIRLINE }}>
            <dt className="font-mono-ui text-[0.54rem] uppercase tracking-[0.16em]" style={{ color: ORACLE_BLUE }}>Prepared intent</dt>
            <dd className="mt-1 text-[0.72rem]" style={{ color: ORACLE_MUTE }}>
              Quote data is ready for independent wallet or local-signer review. Nothing was signed or broadcast.
            </dd>
          </div>
          <div className="flex justify-between gap-3 sm:col-span-2">
            <dt style={{ color: ORACLE_MUTE }}>Receive</dt>
            <dd className="font-mono-ui">
              {quote.buyAmountFormatted ?? formatAmount(quote.buyAmount)} {quote.buySymbol}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: ORACLE_MUTE }}>Rate</dt>
            <dd className="font-mono-ui">{quote.rate ?? "unknown"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: ORACLE_MUTE }}>Route</dt>
            <dd className="font-mono-ui">{quote.routeLabel ?? "unknown"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: ORACLE_MUTE }}>Price impact</dt>
            <dd className="font-mono-ui">
              {quote.priceImpactPct === null ? "unknown" : quote.priceImpactPct.toFixed(2) + "%"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: ORACLE_MUTE }}>Slippage cap</dt>
            <dd className="font-mono-ui">
              {quote.slippageBps === null || quote.slippageBps === 0
                ? "not quoted by route"
                : (quote.slippageBps / 100).toFixed(2) + "%"}
            </dd>
          </div>
          <div className="flex justify-between gap-3 sm:col-span-2">
            <dt style={{ color: ORACLE_MUTE }}>Intent hash</dt>
            <dd className="font-mono-ui">{shortHash(quote.intentHash)}</dd>
          </div>
        </dl>
      )}

      <p className="text-[0.72rem]" style={{ color: ORACLE_MUTE }}>
        This pane never holds a private key or takes custody. It only prepares an
        intent for independent wallet or local-signer review.
      </p>
    </section>
  );
}

export default SwapPane;
