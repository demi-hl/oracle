"use client";

import { useEffect, useMemo, useState } from "react";
import { usePolling } from "@/components/usePolling";
import { PullToRefresh, RefreshIcon } from "@/components/panes/parts";
import { haptic } from "@/components/shell/haptics";
import { ChevronRightIcon } from "@/components/shell/icons";
import { OracleCore, type OracleCoreSpecialist } from "./OracleCore";
import { OracleMark } from "./OracleMark";
import { TaskComposer } from "./TaskComposer";
import { CliPlane } from "./CliPlane";

const ORACLE_BLUE = "#7CC4FF";

type RecordLike = Record<string, unknown>;
type PublicAvailability = "loading" | "available" | "unavailable" | "reported";

interface RuntimeView {
  state: PublicAvailability;
  label: string;
  detail: string;
}

interface CatalogSpecialist extends OracleCoreSpecialist {
  description?: string;
  url?: string;
}

const VENUE_LABELS: Record<string, string> = {
  hl: "Hyperliquid",
  hyperliquid: "Hyperliquid",
  poly: "Polymarket",
  polymarket: "Polymarket",
  rh: "Robinhood Chain",
  jupiter: "Jupiter",
  evm: "EVM",
  solana: "Solana",
  bitcoin: "Bitcoin",
};

const ID_WORDS: Record<string, string> = {
  hl: "Hyperliquid",
  poly: "Polymarket",
  rh: "Robinhood",
  evm: "EVM",
  v2: "V2",
  v3: "V3",
  v4: "V4",
  nft: "NFT",
  nfts: "NFTs",
  rpc: "RPC",
  dex: "DEX",
  defi: "DeFi",
};

function asRecord(value: unknown): RecordLike | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

function firstString(record: RecordLike, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_./\s]+/)
    .filter(Boolean)
    .map((part) => ID_WORDS[part.toLowerCase()] ?? part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function catalogLabel(record: RecordLike): string | undefined {
  const explicit = firstString(record, ["label", "name", "title", "displayName"]);
  if (explicit) return explicit;

  const id = firstString(record, ["id", "slug"]);
  const venue = firstString(record, ["venue", "chain", "provider"]);
  const venueLabel = venue ? (VENUE_LABELS[venue.toLowerCase()] ?? titleFromId(venue)) : undefined;
  if (id) {
    const idTitle = titleFromId(id);
    return venueLabel && !idTitle.toLowerCase().startsWith(venueLabel.toLowerCase())
      ? `${venueLabel} ${idTitle}`
      : idTitle;
  }
  return venueLabel;
}

function catalogDetail(record: RecordLike): string | undefined {
  const execution = firstString(record, ["execution"]);
  const venue = firstString(record, ["venue", "chain", "provider"]);
  const auth = firstString(record, ["auth"]);
  return [execution, venue, auth === "none" ? "public" : auth].filter(Boolean).join(" · ") || undefined;
}

function catalogUrl(record: RecordLike): string | undefined {
  const direct = firstString(record, ["url", "website", "previewUrl", "appUrl"]);
  if (direct) return direct;
  const metadata = asRecord(record.metadata);
  return metadata ? firstString(metadata, ["url", "website", "previewUrl", "appUrl"]) : undefined;
}

function publicSignal(payload: unknown): boolean | null {
  let record = asRecord(payload);
  const nested = record ? asRecord(record.data) : null;
  if (nested) record = nested;
  if (!record) return null;

  for (const key of ["available", "ok", "healthy", "ready"]) {
    if (typeof record[key] === "boolean") return record[key] as boolean;
  }

  const status = firstString(record, ["status", "state", "health"]);
  if (!status) return null;
  const normalized = status.toLowerCase();
  if (["available", "online", "ready", "healthy", "ok"].includes(normalized)) return true;
  if (["unavailable", "offline", "down", "error", "unconfigured"].includes(normalized)) return false;
  return null;
}

function normalizeRuntime(
  payload: unknown,
  loading: boolean,
  error: string | null,
): RuntimeView {
  if (loading && payload == null) {
    return {
      state: "loading",
      label: "Checking status",
      detail: "Waiting for the Oracle status endpoint.",
    };
  }

  const signal = publicSignal(payload);
  if (signal === true) {
    return {
      state: "available",
      label: "Oracle available",
      detail: error
        ? "The last response was available. The latest refresh could not be confirmed."
        : "The public status endpoint reports availability.",
    };
  }
  if (signal === false) {
    return {
      state: "unavailable",
      label: "Oracle unavailable",
      detail: "The public status endpoint does not report availability.",
    };
  }
  if (error) {
    return {
      state: "unavailable",
      label: "Status unavailable",
      detail: "Oracle status could not be confirmed.",
    };
  }
  if (payload != null) {
    return {
      state: "reported",
      label: "Status received",
      detail: "The endpoint responded without a public availability signal.",
    };
  }
  return {
    state: "unavailable",
    label: "No status reported",
    detail: "Oracle status could not be confirmed.",
  };
}

const CATALOG_KEYS = [
  "specialists",
  "profiles",
  "agents",
  "catalog",
  "items",
  "capabilities",
  "pack",
];

function findCatalogEntries(value: unknown, depth = 0): unknown[] {
  if (depth > 3) return [];
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];

  for (const key of CATALOG_KEYS) {
    if (!(key in record)) continue;
    const found = findCatalogEntries(record[key], depth + 1);
    if (found.length > 0 || Array.isArray(record[key])) return found;
  }

  const nested = record.data;
  return nested === undefined ? [] : findCatalogEntries(nested, depth + 1);
}

function normalizeCatalog(payload: unknown): CatalogSpecialist[] {
  const entries = findCatalogEntries(payload);
  const seen = new Set<string>();
  const specialists: CatalogSpecialist[] = [];

  entries.forEach((entry, index) => {
    if (typeof entry === "string" && entry.trim()) {
      const label = entry.trim();
      const key = label.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        specialists.push({ id: `catalog-${index}-${key}`, label });
      }
      return;
    }

    const record = asRecord(entry);
    if (!record) return;
    const label = catalogLabel(record);
    if (!label) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const description = firstString(record, ["description", "blurb", "summary"]);
    const detail = firstString(record, ["kind", "category", "type"]) ?? catalogDetail(record);
    specialists.push({
      id: firstString(record, ["slug"]) ?? `catalog-${index}-${key}`,
      label,
      detail,
      description,
      url: catalogUrl(record),
    });
  });

  return specialists;
}

function navigate(tab: string) {
  void haptic(7);
  window.dispatchEvent(new CustomEvent("lo-nav", { detail: { tab } }));
}

const PUBLIC_BOUNDARY = [
  {
    label: "CLI",
    value: "PUBLIC",
    detail: "The command plane installs as @oracle-agent/oracle and shares the same contract surface.",
  },
  {
    label: "WEB",
    value: "KEYLESS",
    detail: "The browser bundle reads portfolio, routes, status, and prepares intents only.",
  },
  {
    label: "SIGNER",
    value: "EXTERNAL",
    detail: "Armed or disarmed state is observed from the local signer. Signing does not move into the app.",
  },
];

function StatusDot({ state }: { state: PublicAvailability }) {
  const color =
    state === "available"
      ? ORACLE_BLUE
      : state === "loading"
        ? "rgba(124,196,255,0.54)"
        : "rgba(195,205,217,0.3)";
  return (
    <span
      className={state === "loading" ? "h-1.5 w-1.5 animate-pulse rounded-full" : "h-1.5 w-1.5 rounded-full"}
      style={{
        backgroundColor: color,
        boxShadow: state === "available" ? `0 0 8px ${ORACLE_BLUE}` : undefined,
      }}
      aria-hidden
    />
  );
}

function LoadingCatalog() {
  return (
    <div className="divide-y divide-[var(--fable-line)] border-y border-[var(--fable-line)]">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex h-[52px] animate-pulse items-center gap-4 px-1">
          <span className="h-1 w-1 rounded-full bg-[#7CC4FF]/25" />
          <span className="block h-2.5 w-40 rounded-full bg-[#C3CDD9]/10" />
          <span className="ml-auto block h-2 w-24 rounded-full bg-[#7CC4FF]/[0.07]" />
        </div>
      ))}
    </div>
  );
}

function BoundaryCard({ label, value, detail }: (typeof PUBLIC_BOUNDARY)[number]) {
  return (
    <article className="group relative py-4 pl-5 sm:py-1 sm:pl-6">
      <span
        className="absolute left-0 top-0 h-full w-px bg-[var(--fable-line-strong)] transition-colors duration-300 group-hover:bg-[#7CC4FF]/60"
        aria-hidden
      />
      <div className="flex items-baseline gap-3">
        <span className="font-mono-ui text-[0.54rem] uppercase tracking-[0.22em] text-[var(--fable-ink-low)]">{label}</span>
        <span className="fable-display text-[1.4rem] leading-none tracking-[0.04em]">{value}</span>
      </div>
      <p className="mt-3 max-w-[34ch] text-[0.72rem] leading-relaxed text-[var(--fable-ink-mid)]">{detail}</p>
    </article>
  );
}

function WalletStatusReadout({ evm }: { evm: string }) {
  const portfolio = usePolling<{
    totals?: { valueUsd?: string | null; assetCount?: number };
  }>(`/api/oracle/portfolio?evm=${encodeURIComponent(evm)}`, 120_000);

  const approvals = usePolling<{
    totals?: { operatorCount?: number; unlimitedCount?: number };
  }>(`/api/oracle/approvals?evm=${encodeURIComponent(evm)}`, 180_000);

  const value = portfolio.data?.totals?.valueUsd;
  const valueLabel = value
    ? `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : portfolio.loading
      ? "reading"
      : "unavailable";

  // Every ERC-721 row is flagged unlimited (approvals/route.ts:127) and an
  // operator grant IS an ERC-721 row, so operatorCount is a subset of
  // unlimitedCount. Adding them counted every blanket NFT operator twice and
  // inflated the exposure number the user sees on the home surface.
  const exposure = approvals.data?.totals?.unlimitedCount ?? 0;

  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono-ui text-[0.58rem] uppercase tracking-[0.13em] text-[var(--fable-ink-low)]">
      <span className="tabular text-[0.66rem] text-[var(--fable-ink)]">{valueLabel}</span>
      <span aria-hidden className="text-[var(--fable-ink-low)]/60">/</span>
      <span>
        {portfolio.data?.totals?.assetCount === undefined
          ? "assets unknown"
          : `${portfolio.data.totals.assetCount} assets`}
      </span>
      {exposure > 0 && (
        <>
          <span aria-hidden className="text-[var(--fable-ink-low)]/60">/</span>
          <span style={{ color: (approvals.data?.totals?.operatorCount ?? 0) > 0 ? "#E98791" : "#F3C879" }}>
            {exposure} open approval{exposure === 1 ? "" : "s"}
          </span>
        </>
      )}
      <span aria-hidden className="text-[var(--fable-ink-low)]/60">/</span>
      <span className="text-[#7CC4FF]/70">keyless</span>
    </div>
  );
}

/**
 * Compact wallet status, mirroring the CLI's one-line status bar.
 *
 * The CLI answers "where do I stand" in a single line under the prompt rather
 * than a dashboard above it. This keeps the money visible without letting it
 * outrank the ask, which is what pushed chat to seventh place before.
 *
 * Silent when no wallet is connected: an empty strip would be chrome that never
 * pays rent.
 */
function WalletStatusStrip() {
  const [evm, setEvm] = useState<string | null>(null);
  useEffect(() => {
    try {
      setEvm(window.localStorage.getItem("oracle-portfolio-evm"));
    } catch {
      setEvm(null);
    }
  }, []);

  if (!evm) return null;
  return <WalletStatusReadout evm={evm} />;
}

/** Oracle's responsive, data-honest home and dashboard leaf. */
export function OracleHomePane() {
  const statusPoll = usePolling<unknown>("/api/oracle/status", 15_000);
  const catalogPoll = usePolling<unknown>("/api/oracle/catalog", 60_000);

  const runtime = useMemo(
    () => normalizeRuntime(statusPoll.data, statusPoll.loading, statusPoll.error),
    [statusPoll.data, statusPoll.error, statusPoll.loading],
  );
  const specialists = useMemo(
    () => normalizeCatalog(catalogPoll.data),
    [catalogPoll.data],
  );

  const catalogFirstLoad = catalogPoll.loading && catalogPoll.data == null;
  const catalogUnavailable = Boolean(catalogPoll.error && specialists.length === 0);
  const catalogLabel = catalogFirstLoad
    ? "Loading catalog"
    : catalogUnavailable
      ? "Catalog unavailable"
      : specialists.length > 0
        ? `${specialists.length} public profile${specialists.length === 1 ? "" : "s"} reported`
        : "No public profiles reported";

  const refresh = () => {
    statusPoll.reload();
    catalogPoll.reload();
  };

  return (
    <PullToRefresh onRefresh={refresh}>
      <section
        className="relative min-h-full overflow-hidden"
        style={{
          backgroundColor: "#060A10",
          color: "#C3CDD9",
          backgroundImage:
            "radial-gradient(1100px 460px at 76% -10%, rgba(124,196,255,0.065), transparent 64%), linear-gradient(180deg, rgba(236,231,218,0.016), transparent 26%)",
          fontFamily: 'var(--theme-font-sans), Inter, ui-sans-serif, system-ui, sans-serif',
        }}
      >
        <div className="relative mx-auto flex w-full max-w-[1200px] flex-col px-4 pb-16 pt-3 sm:px-6 lg:px-10 lg:pt-5">
          <header className="flex items-center gap-3 border-b border-[var(--fable-line)] pb-3">
            <OracleMark size={35} />
            <span className="hidden h-4 w-px bg-[var(--fable-line-strong)] sm:block" aria-hidden />
            <span className="hidden font-mono-ui text-[0.56rem] uppercase tracking-[0.22em] text-[var(--fable-ink-low)] sm:block">
              multichain AI control plane
            </span>
            <span className="ml-auto flex items-center gap-2 font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[var(--fable-ink-mid)]">
              <StatusDot state={runtime.state} />
              {runtime.label}
            </span>
            <button
              type="button"
              onClick={() => {
                void haptic(5);
                refresh();
              }}
              aria-label="Refresh Oracle status and catalog"
              className="grid h-8 w-8 place-items-center rounded-full border border-transparent text-[var(--fable-ink-low)] transition-colors hover:border-[var(--fable-line-strong)] hover:text-[#7CC4FF] active:scale-90"
            >
              <span className={statusPoll.loading || catalogPoll.loading ? "animate-spin" : ""}>
                <RefreshIcon width={14} height={14} />
              </span>
            </button>
          </header>

          <section
            aria-labelledby="oracle-home-heading"
            className="grid gap-10 pb-12 pt-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-8 lg:pb-20 lg:pt-16"
          >
            <div className="max-w-[620px]">
              <span className="fable-eyebrow">policy-bounded by default</span>
              <h1
                id="oracle-home-heading"
                className="fable-display mt-5 max-w-[13ch] text-[2.7rem] leading-[1.02] sm:text-[3.5rem] lg:text-[4.3rem]"
              >
                One task in. The right specialist out.
              </h1>
              <p className="mt-6 max-w-[44ch] text-[0.86rem] leading-[1.75] text-[var(--fable-ink-mid)] sm:text-[0.92rem]">
                Oracle routes your multichain task through a specialist mesh under clear limits. Portfolio and market intelligence stay read-only.
              </p>
              <WalletStatusStrip />

              <div className="mt-9">
                <TaskComposer
                  specialists={specialists}
                  catalogLoading={catalogFirstLoad}
                  catalogUnavailable={catalogUnavailable}
                  onOpenPrepare={() => navigate("swap")}
                />
              </div>
            </div>

            <div className="flex items-center lg:pl-2">
              <OracleCore
                specialists={specialists}
                loading={catalogFirstLoad}
                unavailable={catalogUnavailable}
                className="mx-auto max-w-[900px]"
              />
            </div>
          </section>

          <section
            aria-label="Prepare-only access posture"
            className="flex flex-col gap-3 border-y border-[var(--fable-line)] py-4 sm:flex-row sm:items-center sm:gap-8"
          >
            <div className="flex items-baseline gap-3">
              <span className="h-2 w-2 self-center rounded-full border border-[#7CC4FF]/60 bg-transparent shadow-[0_0_10px_rgba(124,196,255,0.22)]" aria-hidden />
              <span className="font-mono-ui text-[0.56rem] uppercase tracking-[0.22em] text-[var(--fable-ink-low)]">Access</span>
              <strong className="fable-display text-[1.2rem] font-normal leading-none tracking-[0.06em]">PREPARE-ONLY</strong>
            </div>
            <p className="max-w-[52ch] text-[0.74rem] leading-relaxed text-[var(--fable-ink-mid)] sm:flex-1">
              Reads portfolio, market, and runtime state, and prepares quotes and unsigned revoke calldata. It never signs or broadcasts. Only a local signer can execute, after you arm it outside this app.
            </p>
            <button
              type="button"
              onClick={() => navigate("portfolio")}
              className="group flex items-center gap-2 self-start font-mono-ui text-[0.58rem] uppercase tracking-[0.16em] text-[#7CC4FF]/80 transition-colors hover:text-[#7CC4FF] sm:self-center"
            >
              View coverage
              <ChevronRightIcon width={13} height={13} className="transition-transform duration-300 group-hover:translate-x-0.5" />
            </button>
          </section>

          <section aria-label="Product surfaces" className="mt-14 lg:mt-20">
            <span className="fable-eyebrow">Surface</span>
            <div className="mt-4">
              {[
                ["equities", "Crossbook", "Separate product for on-chain equities best-ex across HIP-3, Arcus, RH, Solana, and TON. Prepare-only."],
                ["connect", "Agent Connect", "Copy MCP configs for Hermes, Claude Code, Codex, Cursor, and generic clients."],
                ["farming", "Farming Methods", "Design delta-neutral protocol farming recipes with exposure, hedge cost, monitoring, and exit rules."],
                ["receipts", "Receipts", "Inspect intent, route, boundary stamps, hashes, tx status, and balances."],
                ["campaigns", "Campaigns", "Bind watch triggers to alerts, prepare mode, or owner arm requests."],
              ].map(([tab, label, detail], index) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => navigate(tab)}
                  className="group flex w-full items-baseline gap-5 border-b border-[var(--fable-line)] py-5 text-left transition-colors duration-300 first:border-t hover:border-b-[var(--fable-line-strong)] sm:gap-8 lg:py-6"
                >
                  <span className="tabular shrink-0 font-mono-ui text-[0.6rem] text-[var(--fable-ink-low)]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-8">
                    <h2 className="fable-display text-[1.5rem] leading-tight transition-colors duration-300 group-hover:text-[#7CC4FF] sm:min-w-[240px] lg:text-[1.9rem]">
                      {label}
                    </h2>
                    <p className="mt-1.5 max-w-[52ch] text-[0.72rem] leading-relaxed text-[var(--fable-ink-mid)] sm:mt-0">
                      {detail}
                    </p>
                  </span>
                  <ChevronRightIcon
                    width={15}
                    height={15}
                    className="shrink-0 self-center text-[var(--fable-ink-low)] transition-all duration-300 group-hover:translate-x-1 group-hover:text-[#7CC4FF]"
                  />
                </button>
              ))}
            </div>
          </section>

          <CliPlane />

          <section aria-label="Public release boundary" className="mt-14 grid gap-8 sm:grid-cols-3 sm:gap-6 lg:mt-20">
            {PUBLIC_BOUNDARY.map((item) => <BoundaryCard key={item.label} {...item} />)}
          </section>

          <section aria-labelledby="oracle-truth-heading" className="mt-16 lg:mt-24">
            <span className="fable-eyebrow">Live checks</span>
            <h2 id="oracle-truth-heading" className="fable-display mt-2 text-[1.6rem] leading-tight lg:text-[1.9rem]">Runtime truth</h2>
            <div className="mt-5 divide-y divide-[var(--fable-line)] border-y border-[var(--fable-line)]">
              <div className="grid gap-2 py-5 sm:grid-cols-[200px_260px_1fr] sm:gap-8">
                <div className="flex items-center gap-2 self-start font-mono-ui text-[0.56rem] uppercase tracking-[0.18em] text-[var(--fable-ink-low)]">
                  <StatusDot state={runtime.state} />
                  Status endpoint
                </div>
                <p className="text-[0.92rem] text-[var(--fable-ink)]">{runtime.label}</p>
                <p className="max-w-[58ch] text-[0.72rem] leading-relaxed text-[var(--fable-ink-mid)]">{runtime.detail}</p>
              </div>
              <div className="grid gap-2 py-5 sm:grid-cols-[200px_260px_1fr] sm:gap-8">
                <div className="flex items-center gap-2 self-start font-mono-ui text-[0.56rem] uppercase tracking-[0.18em] text-[var(--fable-ink-low)]">
                  <StatusDot state={catalogFirstLoad ? "loading" : catalogUnavailable ? "unavailable" : "reported"} />
                  Catalog endpoint
                </div>
                <p className="text-[0.92rem] text-[var(--fable-ink)]">{catalogLabel}</p>
                <p className="max-w-[58ch] text-[0.72rem] leading-relaxed text-[var(--fable-ink-mid)]">
                  {catalogUnavailable
                    ? "Specialist availability could not be confirmed."
                    : "Only profiles returned by the public catalog are shown below."}
                </p>
              </div>
            </div>
          </section>

          <section aria-labelledby="oracle-catalog-heading" className="mt-16 lg:mt-24">
            <div className="mb-5 flex items-end justify-between gap-3">
              <div>
                <span className="fable-eyebrow">Specialist mesh</span>
                <h2 id="oracle-catalog-heading" className="fable-display mt-2 text-[1.6rem] leading-tight lg:text-[1.9rem]">Reported catalog</h2>
              </div>
            </div>

            {catalogFirstLoad ? (
              <LoadingCatalog />
            ) : catalogUnavailable ? (
              <div className="relative border-y border-[var(--fable-line)] py-9 pl-6">
                <span className="absolute left-0 top-0 h-full w-px bg-[var(--fable-line-strong)]" aria-hidden />
                <p className="text-[0.9rem] text-[var(--fable-ink)]">Catalog unavailable</p>
                <p className="mt-2 font-mono-ui text-[0.58rem] uppercase tracking-[0.14em] text-[var(--fable-ink-low)]">No specialist profiles are being inferred.</p>
              </div>
            ) : specialists.length === 0 ? (
              <div className="relative border-y border-[var(--fable-line)] py-9 pl-6">
                <span className="absolute left-0 top-0 h-full w-px bg-[var(--fable-line-strong)]" aria-hidden />
                <p className="text-[0.9rem] text-[var(--fable-ink)]">No public specialist profiles reported</p>
                <p className="mt-2 font-mono-ui text-[0.58rem] uppercase tracking-[0.14em] text-[var(--fable-ink-low)]">The catalog response was empty.</p>
              </div>
            ) : (
              <ol className="grid border-t border-[var(--fable-line)] sm:grid-cols-2 sm:gap-x-14">
                {specialists.map((specialist, index) => (
                  <li
                    key={specialist.id}
                    className="group flex items-baseline gap-4 border-b border-[var(--fable-line)] py-3.5 transition-colors duration-300 hover:border-b-[var(--fable-line-strong)]"
                  >
                    <span className="tabular w-6 shrink-0 font-mono-ui text-[0.56rem] text-[var(--fable-ink-low)]">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[0.84rem] text-[var(--fable-ink)] transition-colors duration-300 group-hover:text-[var(--fable-ink-hi)]">{specialist.label}</h3>
                      {specialist.description && (
                        <p className="truncate text-[0.66rem] leading-relaxed text-[var(--fable-ink-low)]">{specialist.description}</p>
                      )}
                    </div>
                    <span className="max-w-[38%] shrink-0 truncate font-mono-ui text-[0.5rem] uppercase tracking-[0.14em] text-[#7CC4FF]/55">
                      {specialist.detail ?? "reported profile"}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </section>
    </PullToRefresh>
  );
}

export default OracleHomePane;
