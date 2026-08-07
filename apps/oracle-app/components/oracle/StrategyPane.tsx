"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EvidenceCard,
  evidenceStatusLabel,
  normalizeEvidenceStatus,
  type EvidenceMetrics,
  type EvidenceStatusCode,
} from "./strategy/EvidenceCard";
import { StrategyGraph, type StrategyGraphNode } from "./strategy/StrategyGraph";
import { StrategyStatus, type DslValidity, type ShadowStatusLabel } from "./strategy/StrategyStatus";

const ORACLE_BLUE = "#7CC4FF";
const DEMI_CYAN = "#B8F0FF";
const HAIRLINE = "rgba(124,196,255,.16)";
const MUTE = "#9FB8D2";
const INK = "#F4F9FE";
const BG = "#0B1018";
const PANEL = "#071019";
const ERR = "#FF8B8B";

const PROMPT_PLACEHOLDER =
  "Long BTC when the 20 EMA crosses above the 50 EMA. Exit on the reverse cross.";

type BusyKey =
  | "idle"
  | "draft"
  | "validate"
  | "backtest"
  | "optimize"
  | "shadow-start"
  | "shadow-stop"
  | "prepare";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (isRecord(body)) {
    if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
    if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
    if (Array.isArray(body.errors)) {
      const parts = body.errors
        .map((e) => {
          if (typeof e === "string") return e;
          if (isRecord(e) && typeof e.message === "string") return e.message;
          return null;
        })
        .filter((x): x is string => Boolean(x));
      if (parts.length) return parts.join("; ");
    }
  }
  return fallback;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 2000) };
  }
}

function extractStrategyPayload(body: unknown): unknown {
  if (!isRecord(body)) return null;
  if (body.strategy != null) return body.strategy;
  if (body.dsl != null) return body.dsl;
  if (body.draft != null) return body.draft;
  return null;
}

function strategyToDslText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function parseStrategyObject(dslText: string): { strategy: unknown; error: string | null } {
  const trimmed = dslText.trim();
  if (!trimmed) return { strategy: null, error: "DSL is empty" };
  try {
    return { strategy: JSON.parse(trimmed) as unknown, error: null };
  } catch (e) {
    return { strategy: null, error: e instanceof Error ? e.message : "invalid JSON" };
  }
}

function extractNodes(strategy: unknown): { nodes: StrategyGraphNode[]; error: string | null } {
  if (strategy == null) return { nodes: [], error: null };
  if (!isRecord(strategy)) return { nodes: [], error: "strategy is not an object" };

  let rawNodes: unknown = null;
  if (isRecord(strategy.graph) && Array.isArray(strategy.graph.nodes)) {
    rawNodes = strategy.graph.nodes;
  } else if (Array.isArray(strategy.nodes)) {
    rawNodes = strategy.nodes;
  }

  if (rawNodes == null) return { nodes: [], error: null };
  if (!Array.isArray(rawNodes)) return { nodes: [], error: "graph.nodes is not an array" };

  const nodes: StrategyGraphNode[] = [];
  for (const item of rawNodes) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id : null;
    const type = typeof item.type === "string" ? item.type : null;
    if (!id || !type) continue;
    const node: StrategyGraphNode = { id, type };
    if (isRecord(item.params)) node.params = item.params;
    if (isRecord(item.config)) node.config = item.config;
    if (Array.isArray(item.inputs)) node.inputs = item.inputs.filter((x): x is string => typeof x === "string");
    if (typeof item.input === "string") node.input = item.input;
    if (Array.isArray(item.input)) node.input = item.input.filter((x): x is string => typeof x === "string");
    if (typeof item.left === "string") node.left = item.left;
    if (typeof item.right === "string") node.right = item.right;
    nodes.push(node);
  }
  return { nodes, error: null };
}

function extractEvidence(body: unknown): {
  status: EvidenceStatusCode;
  train: EvidenceMetrics | null;
  holdout: EvidenceMetrics | null;
  walkForward: { passRate?: number | null } | null;
  flags: string[] | null;
} {
  const root = isRecord(body) ? body : {};
  const evidence = isRecord(root.evidence) ? root.evidence : root;
  const status = normalizeEvidenceStatus(evidence.status ?? root.status);
  const train = isRecord(evidence.train)
    ? (evidence.train as EvidenceMetrics)
    : isRecord(root.train)
      ? (root.train as EvidenceMetrics)
      : null;
  const holdout = isRecord(evidence.holdout)
    ? (evidence.holdout as EvidenceMetrics)
    : isRecord(root.holdout)
      ? (root.holdout as EvidenceMetrics)
      : null;
  const wfRaw = isRecord(evidence.walkForward)
    ? evidence.walkForward
    : isRecord(root.walkForward)
      ? root.walkForward
      : null;
  const walkForward = wfRaw
    ? {
        passRate:
          typeof wfRaw.passRate === "number"
            ? wfRaw.passRate
            : wfRaw.passRate == null
              ? null
              : null,
      }
    : null;
  const flagsRaw = Array.isArray(evidence.flags)
    ? evidence.flags
    : Array.isArray(root.flags)
      ? root.flags
      : null;
  const flags = flagsRaw
    ? flagsRaw.filter((f): f is string => typeof f === "string")
    : null;
  return { status, train, holdout, walkForward, flags };
}

function normalizeShadowLabel(raw: unknown): ShadowStatusLabel {
  if (typeof raw !== "string") return "STOPPED";
  const s = raw.trim().toLowerCase();
  if (s === "shadowing" || s === "running" || s === "active" || s === "started") return "SHADOWING";
  if (s === "error" || s === "failed" || s === "crashed") return "ERROR";
  if (s === "stopped" || s === "idle" || s === "stop") return "STOPPED";
  return "STOPPED";
}

function buttonClass(primary = false): string {
  return primary
    ? "rounded-none border px-3 py-2 font-mono-ui text-[0.58rem] uppercase tracking-[0.14em] disabled:opacity-40"
    : "rounded-none border px-3 py-2 font-mono-ui text-[0.58rem] uppercase tracking-[0.14em] disabled:opacity-40";
}

/**
 * Strategy Lab workspace leaf.
 *
 * Prompt or DSL, inspect graph, backtest, inspect evidence, shadow, then prepare
 * a local handoff. Saving or shadowing is never presented as armed trading.
 */
export function StrategyPane() {
  const [prompt, setPrompt] = useState("");
  const [dsl, setDsl] = useState("");
  const [draftSaved, setDraftSaved] = useState(false);
  const [busy, setBusy] = useState<BusyKey>("idle");
  const [error, setError] = useState<string | null>(null);

  const [dslState, setDslState] = useState<DslValidity>("unknown");
  const [evidenceStatus, setEvidenceStatus] = useState<EvidenceStatusCode>("unknown");
  const [train, setTrain] = useState<EvidenceMetrics | null>(null);
  const [holdout, setHoldout] = useState<EvidenceMetrics | null>(null);
  const [walkForward, setWalkForward] = useState<{ passRate?: number | null } | null>(null);
  const [flags, setFlags] = useState<string[] | null>(null);

  const [shadow, setShadow] = useState<ShadowStatusLabel>("STOPPED");
  const [shadowId, setShadowId] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<unknown>(null);
  const [graphParseError, setGraphParseError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.localStorage.getItem("oracle.strategy.draft.v1");
      if (typeof saved === "string" && saved.trim()) {
        setDsl(saved);
        setDraftSaved(true);
      }
    } catch {
      // storage may be blocked; draft load is optional
    }
  }, []);

  const parsed = useMemo(() => parseStrategyObject(dsl), [dsl]);
  const graph = useMemo(() => {
    if (parsed.error) return { nodes: [] as StrategyGraphNode[], error: parsed.error };
    return extractNodes(parsed.strategy);
  }, [parsed]);

  useEffect(() => {
    setGraphParseError(graph.error);
  }, [graph.error]);

  const evidenceLabel = evidenceStatusLabel(evidenceStatus);

  const canPrepare =
    evidenceStatus === "pass_live_eligible" && shadow !== "ERROR" && parsed.error == null && parsed.strategy != null;

  const postJson = useCallback(async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const json = await readJson(res);
    return { res, json };
  }, []);

  const runDraft = useCallback(async () => {
    setBusy("draft");
    setError(null);
    try {
      const { res, json } = await postJson("/api/oracle/strategy/draft", { prompt });
      if (!res.ok) {
        setError(asErrorMessage(json, `Draft unavailable (${res.status})`));
        return;
      }
      const strategy = extractStrategyPayload(json);
      if (strategy == null) {
        setError(asErrorMessage(json, "Draft unavailable: empty strategy payload"));
        return;
      }
      setDsl(strategyToDslText(strategy));
      setDraftSaved(false);
      setDslState("unknown");
      setPrepared(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Draft unavailable");
    } finally {
      setBusy("idle");
    }
  }, [postJson, prompt]);

  const runValidate = useCallback(async () => {
    setBusy("validate");
    setError(null);
    const { strategy, error: parseErr } = parseStrategyObject(dsl);
    if (parseErr || strategy == null) {
      setDslState("invalid");
      setError(parseErr || "DSL INVALID");
      setBusy("idle");
      return;
    }
    try {
      const { res, json } = await postJson("/api/oracle/strategy/validate", { strategy });
      if (!res.ok) {
        setDslState("invalid");
        setError(asErrorMessage(json, `Validate failed (${res.status})`));
        return;
      }
      const ok =
        isRecord(json) &&
        (json.ok === true ||
          json.valid === true ||
          (isRecord(json.validation) && json.validation.ok === true));
      const explicitFail =
        isRecord(json) && (json.ok === false || json.valid === false);
      if (explicitFail) {
        setDslState("invalid");
        setError(asErrorMessage(json, "DSL INVALID"));
        return;
      }
      setDslState(ok || res.ok ? "valid" : "invalid");
      if (!ok && !res.ok) setError(asErrorMessage(json, "DSL INVALID"));
    } catch (e) {
      setDslState("invalid");
      setError(e instanceof Error ? e.message : "Validate failed");
    } finally {
      setBusy("idle");
    }
  }, [dsl, postJson]);

  const saveDraft = useCallback(() => {
    setError(null);
    try {
      if (typeof window === "undefined") {
        setError("localStorage unavailable");
        return;
      }
      window.localStorage.setItem("oracle.strategy.draft.v1", dsl);
      setDraftSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save draft failed");
    }
  }, [dsl]);

  const applyEvidenceBody = useCallback((json: unknown) => {
    const ev = extractEvidence(json);
    setEvidenceStatus(ev.status);
    setTrain(ev.train);
    setHoldout(ev.holdout);
    setWalkForward(ev.walkForward);
    setFlags(ev.flags);
  }, []);

  const runBacktest = useCallback(async () => {
    setBusy("backtest");
    setError(null);
    const { strategy, error: parseErr } = parseStrategyObject(dsl);
    if (parseErr || strategy == null) {
      setError(parseErr || "strategy required for backtest");
      setBusy("idle");
      return;
    }
    try {
      const { res, json } = await postJson("/api/oracle/strategy/backtest", { strategy });
      if (!res.ok) {
        setError(asErrorMessage(json, `Backtest failed (${res.status})`));
        return;
      }
      applyEvidenceBody(json);
      setPrepared(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backtest failed");
    } finally {
      setBusy("idle");
    }
  }, [applyEvidenceBody, dsl, postJson]);

  const runOptimize = useCallback(async () => {
    setBusy("optimize");
    setError(null);
    const { strategy, error: parseErr } = parseStrategyObject(dsl);
    if (parseErr || strategy == null) {
      setError(parseErr || "strategy required for optimize");
      setBusy("idle");
      return;
    }
    try {
      const { res, json } = await postJson("/api/oracle/strategy/optimize", { strategy });
      if (!res.ok) {
        setError(asErrorMessage(json, `Optimize failed (${res.status})`));
        return;
      }
      const next = extractStrategyPayload(json);
      if (next != null) {
        setDsl(strategyToDslText(next));
        setDraftSaved(false);
      }
      applyEvidenceBody(json);
      setPrepared(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Optimize failed");
    } finally {
      setBusy("idle");
    }
  }, [applyEvidenceBody, dsl, postJson]);

  const loadShadow = useCallback(async () => {
    try {
      const res = await fetch("/api/oracle/strategy/shadow", { cache: "no-store" });
      const json = await readJson(res);
      if (!res.ok) return;
      if (!isRecord(json)) return;
      const list = Array.isArray(json.runners)
        ? json.runners
        : Array.isArray(json.shadows)
          ? json.shadows
          : Array.isArray(json.items)
            ? json.items
            : null;
      if (list && list.length > 0 && isRecord(list[0])) {
        const first = list[0];
        if (typeof first.id === "string") setShadowId(first.id);
        setShadow(normalizeShadowLabel(first.status ?? first.state));
        return;
      }
      if (typeof json.id === "string") setShadowId(json.id);
      if (json.status != null || json.state != null) {
        setShadow(normalizeShadowLabel(json.status ?? json.state));
      }
    } catch {
      // list/load is optional chrome
    }
  }, []);

  useEffect(() => {
    void loadShadow();
  }, [loadShadow]);

  const startShadow = useCallback(async () => {
    setBusy("shadow-start");
    setError(null);
    const { strategy, error: parseErr } = parseStrategyObject(dsl);
    if (parseErr || strategy == null) {
      setError(parseErr || "strategy required to start shadow");
      setBusy("idle");
      return;
    }
    try {
      const { res, json } = await postJson("/api/oracle/strategy/shadow", {
        action: "start",
        strategy,
      });
      if (!res.ok) {
        setShadow("ERROR");
        setError(asErrorMessage(json, `Start shadow failed (${res.status})`));
        return;
      }
      if (isRecord(json) && typeof json.id === "string") setShadowId(json.id);
      else if (isRecord(json) && isRecord(json.runner) && typeof json.runner.id === "string") {
        setShadowId(json.runner.id);
      }
      const label = isRecord(json)
        ? normalizeShadowLabel(json.status ?? json.state ?? "shadowing")
        : "SHADOWING";
      setShadow(label === "STOPPED" ? "SHADOWING" : label);
    } catch (e) {
      setShadow("ERROR");
      setError(e instanceof Error ? e.message : "Start shadow failed");
    } finally {
      setBusy("idle");
    }
  }, [dsl, postJson]);

  const stopShadow = useCallback(async () => {
    setBusy("shadow-stop");
    setError(null);
    try {
      const { res, json } = await postJson("/api/oracle/strategy/shadow", {
        action: "stop",
        id: shadowId,
      });
      if (!res.ok) {
        setShadow("ERROR");
        setError(asErrorMessage(json, `Stop shadow failed (${res.status})`));
        return;
      }
      setShadow("STOPPED");
    } catch (e) {
      setShadow("ERROR");
      setError(e instanceof Error ? e.message : "Stop shadow failed");
    } finally {
      setBusy("idle");
    }
  }, [postJson, shadowId]);

  const prepareHandoff = useCallback(async () => {
    if (!canPrepare) {
      setError(
        "Prepare local handoff requires pass_live_eligible evidence and shadow not in ERROR",
      );
      return;
    }
    setBusy("prepare");
    setError(null);
    const { strategy, error: parseErr } = parseStrategyObject(dsl);
    if (parseErr || strategy == null) {
      setError(parseErr || "strategy required");
      setBusy("idle");
      return;
    }
    try {
      const { res, json } = await postJson("/api/oracle/strategy/prepare-live", { strategy });
      if (!res.ok) {
        setError(asErrorMessage(json, `Prepare local handoff failed (${res.status})`));
        return;
      }
      const artifact =
        isRecord(json) && json.prepared != null
          ? json.prepared
          : isRecord(json) && json.handoff != null
            ? json.handoff
            : json;
      setPrepared(artifact);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Prepare local handoff failed");
    } finally {
      setBusy("idle");
    }
  }, [canPrepare, dsl, postJson]);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-3 py-4 sm:px-5" style={{ background: PANEL }}>
      <header className="flex flex-col gap-2 border-b pb-4" style={{ borderColor: HAIRLINE }}>
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.2em]" style={{ color: ORACLE_BLUE }}>
            STRATEGY LAB
          </span>
          {draftSaved ? (
            <span className="font-mono-ui text-[0.5rem] uppercase tracking-[0.14em]" style={{ color: DEMI_CYAN }}>
              SAVED DRAFT
            </span>
          ) : null}
        </div>
        <h1 className="text-[1.15rem] leading-snug tracking-tight sm:text-[1.35rem]" style={{ color: INK }}>
          Turn an idea into a deterministic Hyperliquid strategy.
        </h1>
        <p className="max-w-[72ch] text-[0.74rem] leading-relaxed" style={{ color: MUTE }}>
          Oracle uses closed-bar rules, backtests, and shadow validation before any local handoff. Saving or
          shadowing is never presented as armed trading. Oracle public never broadcasts.
        </p>
      </header>

      <StrategyStatus dsl={dslState} evidenceLabel={evidenceLabel} shadow={shadow} />

      {error ? (
        <p className="text-[0.74rem] leading-relaxed" style={{ color: ERR }} role="alert">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.95fr)]">
        {/* Left workspace */}
        <section aria-label="Strategy workspace" className="flex min-w-0 flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.14em]" style={{ color: MUTE }}>
              Prompt
            </span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={PROMPT_PLACEHOLDER}
              rows={4}
              className="min-h-[96px] w-full resize-y border bg-transparent px-3 py-2 font-mono-ui text-[0.72rem] leading-relaxed outline-none"
              style={{ borderColor: HAIRLINE, color: INK, background: BG }}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            disabled={busy !== "idle" || !prompt.trim()}
            onClick={() => void runDraft()}
            className={buttonClass(true)}
            style={{ borderColor: ORACLE_BLUE, background: ORACLE_BLUE, color: PANEL }}
          >
            {busy === "draft" ? "Drafting..." : "Draft with Oracle"}
          </button>

          <label className="flex flex-col gap-1.5">
            <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.14em]" style={{ color: MUTE }}>
              JSON DSL
            </span>
            <textarea
              value={dsl}
              onChange={(e) => {
                setDsl(e.target.value);
                setDraftSaved(false);
                setDslState("unknown");
              }}
              rows={14}
              className="min-h-[220px] w-full resize-y border bg-transparent px-3 py-2 font-mono-ui text-[0.68rem] leading-relaxed outline-none"
              style={{ borderColor: HAIRLINE, color: INK, background: BG }}
              spellCheck={false}
              placeholder="{}"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== "idle" || !dsl.trim()}
              onClick={() => void runValidate()}
              className={buttonClass()}
              style={{ borderColor: HAIRLINE, color: ORACLE_BLUE }}
            >
              {busy === "validate" ? "Validating..." : "Validate"}
            </button>
            <button
              type="button"
              disabled={busy !== "idle"}
              onClick={saveDraft}
              className={buttonClass()}
              style={{ borderColor: HAIRLINE, color: DEMI_CYAN }}
            >
              Save draft
            </button>
          </div>
          <p className="text-[0.66rem] leading-relaxed" style={{ color: MUTE }}>
            A saved draft is labelled SAVED DRAFT, never active. Only the DSL string is stored under
            oracle.strategy.draft.v1.
          </p>
        </section>

        {/* Center graph */}
        <section aria-label="Strategy graph" className="flex min-w-0 flex-col gap-2">
          <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.14em]" style={{ color: ORACLE_BLUE }}>
            Graph
          </span>
          <StrategyGraph nodes={graph.nodes} parseError={parsed.error ? parsed.error : graphParseError} />
        </section>

        {/* Right evidence lane */}
        <section aria-label="Evidence lane" className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== "idle" || !dsl.trim()}
              onClick={() => void runBacktest()}
              className={buttonClass()}
              style={{ borderColor: ORACLE_BLUE, color: ORACLE_BLUE }}
            >
              {busy === "backtest" ? "Backtesting..." : "Backtest"}
            </button>
            <button
              type="button"
              disabled={busy !== "idle" || !dsl.trim()}
              onClick={() => void runOptimize()}
              className={buttonClass()}
              style={{ borderColor: HAIRLINE, color: INK }}
            >
              {busy === "optimize" ? "Optimizing..." : "Optimize"}
            </button>
          </div>

          <EvidenceCard
            status={evidenceStatus}
            train={train}
            holdout={holdout}
            walkForward={walkForward}
            flags={flags}
          />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== "idle" || !dsl.trim()}
              onClick={() => void startShadow()}
              className={buttonClass()}
              style={{ borderColor: HAIRLINE, color: ORACLE_BLUE }}
            >
              {busy === "shadow-start" ? "Starting..." : "Start shadow"}
            </button>
            <button
              type="button"
              disabled={busy !== "idle"}
              onClick={() => void stopShadow()}
              className={buttonClass()}
              style={{ borderColor: HAIRLINE, color: MUTE }}
            >
              {busy === "shadow-stop" ? "Stopping..." : "Stop shadow"}
            </button>
          </div>
          <p className="font-mono-ui text-[0.52rem] uppercase tracking-[0.12em]" style={{ color: MUTE }}>
            Shadow: {shadow}
            {shadowId ? ` · id ${shadowId}` : ""}
          </p>

          <button
            type="button"
            disabled={busy !== "idle" || !canPrepare}
            onClick={() => void prepareHandoff()}
            className={buttonClass()}
            style={{
              borderColor: canPrepare ? DEMI_CYAN : HAIRLINE,
              color: canPrepare ? DEMI_CYAN : MUTE,
            }}
          >
            {busy === "prepare" ? "Preparing..." : "Prepare local handoff"}
          </button>
          <p className="text-[0.66rem] leading-relaxed" style={{ color: MUTE }}>
            Requires evidence status pass_live_eligible and shadow not ERROR. Returned artifact remains PREPARE ONLY.
          </p>

          {prepared != null ? (
            <div className="border p-3" style={{ borderColor: HAIRLINE, background: BG }}>
              <p className="font-mono-ui text-[0.52rem] uppercase tracking-[0.14em]" style={{ color: DEMI_CYAN }}>
                PREPARE ONLY
              </p>
              <pre
                className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono-ui text-[0.62rem] leading-relaxed"
                style={{ color: MUTE }}
              >
                {strategyToDslText(prepared)}
              </pre>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
