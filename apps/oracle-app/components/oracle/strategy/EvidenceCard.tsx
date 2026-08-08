"use client";

const ORACLE_BLUE = "#7CC4FF";
const HAIRLINE = "rgba(124,196,255,.16)";
const MUTE = "#9FB8D2";
const INK = "#F4F9FE";
const BG = "#0B1018";
const FAIL = "#FF8B8B";
const PAPER = "#E6C07B";
const LIVE = "#7CFFB2";

export type EvidenceStatusCode = "fail" | "pass_paper_only" | "pass_live_eligible" | "unknown";

export interface EvidenceMetrics {
  netPnlUsd?: number | null;
  maxDrawdownPct?: number | null;
  sharpe?: number | null;
  exposurePct?: number | null;
  tradeCount?: number | null;
  winRate?: number | null;
  profitFactor?: number | null;
}

export interface EvidenceCardProps {
  status?: string | null;
  train?: EvidenceMetrics | null;
  holdout?: EvidenceMetrics | null;
  walkForward?: { passRate?: number | null } | null;
  flags?: string[] | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function normalizeEvidenceStatus(raw: unknown): EvidenceStatusCode {
  if (typeof raw !== "string") return "unknown";
  const s = raw.trim().toLowerCase();
  if (s === "fail" || s === "failed") return "fail";
  if (s === "pass_paper_only" || s === "paper_only" || s === "paper") return "pass_paper_only";
  if (s === "pass_live_eligible" || s === "live_eligible") return "pass_live_eligible";
  return "unknown";
}

export function evidenceStatusLabel(code: EvidenceStatusCode): string {
  if (code === "fail") return "FAIL";
  if (code === "pass_paper_only") return "PAPER ONLY";
  if (code === "pass_live_eligible") return "LIVE ELIGIBLE";
  return "UNKNOWN";
}

function statusColor(code: EvidenceStatusCode): string {
  if (code === "fail") return FAIL;
  if (code === "pass_paper_only") return PAPER;
  if (code === "pass_live_eligible") return LIVE;
  return MUTE;
}

function fmtMetric(value: unknown): string {
  if (value == null || value === "") return "UNKNOWN";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "UNKNOWN";
    return String(value);
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return "UNKNOWN";
    return t;
  }
  return "UNKNOWN";
}

function readMetric(block: unknown, key: keyof EvidenceMetrics): string {
  if (!isRecord(block)) return "UNKNOWN";
  return fmtMetric(block[key]);
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-1.5" style={{ borderColor: HAIRLINE }}>
      <span className="font-mono-ui text-[0.5rem] uppercase tracking-[0.12em]" style={{ color: MUTE }}>
        {label}
      </span>
      <span className="font-mono-ui text-[0.68rem] tabular-nums" style={{ color: INK }}>
        {value}
      </span>
    </div>
  );
}

export function EvidenceCard({ status, train, holdout, walkForward, flags }: EvidenceCardProps) {
  const code = normalizeEvidenceStatus(status);
  const label = evidenceStatusLabel(code);
  const color = statusColor(code);
  const flagList = Array.isArray(flags) ? flags.filter((f): f is string => typeof f === "string") : [];
  const passRate =
    walkForward && isRecord(walkForward) ? fmtMetric(walkForward.passRate) : "UNKNOWN";

  return (
    <section
      aria-label="Evidence card"
      className="flex flex-col gap-3 border p-3"
      style={{ borderColor: HAIRLINE, background: BG }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.16em]" style={{ color: ORACLE_BLUE }}>
          Evidence
        </span>
        <span className="font-mono-ui text-[0.62rem] uppercase tracking-[0.14em]" style={{ color }}>
          {label}
        </span>
      </div>

      <p className="text-[0.68rem] leading-relaxed" style={{ color: MUTE }}>
        Eligibility does not arm or execute. LIVE ELIGIBLE is a gate label only.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1 font-mono-ui text-[0.5rem] uppercase tracking-[0.14em]" style={{ color: ORACLE_BLUE }}>
            Train
          </p>
          <MetricRow label="netPnlUsd" value={readMetric(train, "netPnlUsd")} />
          <MetricRow label="maxDrawdownPct" value={readMetric(train, "maxDrawdownPct")} />
          <MetricRow label="sharpe" value={readMetric(train, "sharpe")} />
          <MetricRow label="exposurePct" value={readMetric(train, "exposurePct")} />
          <MetricRow label="tradeCount" value={readMetric(train, "tradeCount")} />
          <MetricRow label="winRate" value={readMetric(train, "winRate")} />
          <MetricRow label="profitFactor" value={readMetric(train, "profitFactor")} />
        </div>
        <div>
          <p className="mb-1 font-mono-ui text-[0.5rem] uppercase tracking-[0.14em]" style={{ color: ORACLE_BLUE }}>
            Holdout
          </p>
          <MetricRow label="netPnlUsd" value={readMetric(holdout, "netPnlUsd")} />
          <MetricRow label="maxDrawdownPct" value={readMetric(holdout, "maxDrawdownPct")} />
          <MetricRow label="sharpe" value={readMetric(holdout, "sharpe")} />
          <MetricRow label="exposurePct" value={readMetric(holdout, "exposurePct")} />
          <MetricRow label="tradeCount" value={readMetric(holdout, "tradeCount")} />
          <MetricRow label="winRate" value={readMetric(holdout, "winRate")} />
          <MetricRow label="profitFactor" value={readMetric(holdout, "profitFactor")} />
        </div>
      </div>

      <MetricRow label="walkForward.passRate" value={passRate} />

      {flagList.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {flagList.map((f) => (
            <li key={f} className="font-mono-ui text-[0.58rem]" style={{ color: MUTE }}>
              flag: {f}
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-mono-ui text-[0.52rem] uppercase tracking-[0.12em]" style={{ color: MUTE }}>
          flags: none
        </p>
      )}
    </section>
  );
}
