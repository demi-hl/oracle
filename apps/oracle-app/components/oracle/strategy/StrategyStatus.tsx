"use client";

const ORACLE_BLUE = "#7CC4FF";
const HAIRLINE = "rgba(124,196,255,.16)";
const MUTE = "#9FB8D2";
const INK = "#F4F9FE";
const BG = "#0B1018";
const OK = "#7CFFB2";
const BAD = "#FF8B8B";
const WARN = "#E6C07B";

export type DslValidity = "valid" | "invalid" | "unknown";
export type ShadowStatusLabel = "STOPPED" | "SHADOWING" | "ERROR";

export interface StrategyStatusProps {
  dsl: DslValidity;
  evidenceLabel: string;
  shadow: ShadowStatusLabel;
}

function dslLabel(dsl: DslValidity): string {
  if (dsl === "valid") return "DSL VALID";
  if (dsl === "invalid") return "DSL INVALID";
  return "DSL UNKNOWN";
}

function dslColor(dsl: DslValidity): string {
  if (dsl === "valid") return OK;
  if (dsl === "invalid") return BAD;
  return MUTE;
}

function shadowColor(shadow: ShadowStatusLabel): string {
  if (shadow === "SHADOWING") return ORACLE_BLUE;
  if (shadow === "ERROR") return BAD;
  return MUTE;
}

function Row({
  kicker,
  value,
  color,
  detail,
}: {
  kicker: string;
  value: string;
  color: string;
  detail?: string;
}) {
  return (
    <div className="border px-3 py-2" style={{ borderColor: HAIRLINE, background: BG }}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono-ui text-[0.48rem] uppercase tracking-[0.14em]" style={{ color: MUTE }}>
          {kicker}
        </span>
        <span className="font-mono-ui text-[0.62rem] uppercase tracking-[0.12em]" style={{ color }}>
          {value}
        </span>
      </div>
      {detail ? (
        <p className="mt-1 text-[0.64rem] leading-relaxed" style={{ color: MUTE }}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}

export function StrategyStatus({ dsl, evidenceLabel, shadow }: StrategyStatusProps) {
  const evidenceColor =
    evidenceLabel === "FAIL"
      ? BAD
      : evidenceLabel === "PAPER ONLY"
        ? WARN
        : evidenceLabel === "LIVE ELIGIBLE"
          ? OK
          : MUTE;

  return (
    <section aria-label="Strategy status" className="flex flex-col gap-2">
      <p className="font-mono-ui text-[0.52rem] uppercase tracking-[0.16em]" style={{ color: ORACLE_BLUE }}>
        Status
      </p>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Row kicker="DSL" value={dslLabel(dsl)} color={dslColor(dsl)} />
        <Row kicker="Evidence" value={evidenceLabel || "UNKNOWN"} color={evidenceColor} />
        <Row kicker="Shadow" value={shadow} color={shadowColor(shadow)} />
        <Row
          kicker="Execution"
          value="NOT ARMED"
          color={INK}
          detail="Local signer required. Oracle public never broadcasts."
        />
      </div>
    </section>
  );
}
