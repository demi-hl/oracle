"use client";

import { useEffect, useMemo, useState } from "react";
import { usePolling } from "@/components/usePolling";
import { RefreshIcon } from "@/components/panes/parts";
import { haptic } from "@/components/shell/haptics";
import { ChevronRightIcon } from "@/components/shell/icons";
import { ORACLE_CHAINS, ORACLE_DATA_PLANE, type OracleChain } from "@oracle-agent/contract";
import { OracleMark } from "./OracleMark";
import { PortfolioCharts } from "./PortfolioCharts";

const ORACLE_BLUE = "#7CC4FF";
type ChainState = "available" | "empty" | "degraded" | "unavailable" | "unconfigured";

interface PortfolioRow {
  id: string;
  chainId: string;
  chainNumericId: number | null;
  kind: string;
  symbol: string | null;
  amount: string | null;
  decimals: number | null;
  valueUsd: string | null;
  priced: boolean;
  address: string | null;
  collection: string | null;
}

interface PortfolioChain extends OracleChain {
  state: ChainState;
  assetCount: number;
  valueUsd: string | null;
  unpricedCount: number;
}

interface PortfolioPayload {
  configured: boolean;
  reachable: boolean;
  error: string | null;
  fetchedAt: string;
  generatedAt?: string | null;
  addressFamilies?: string[];
  totals: {
    valueUsd: string | null;
    complete: boolean;
    assetCount: number;
    pricedCount: number;
    unpricedCount: number;
  };
  rows: PortfolioRow[];
  chains: PortfolioChain[];
  // The route has always sent these. The pane never declared them, so the
  // disclosures it emitted — capped rows, implausible rows excluded from the
  // total — were invisible to every consumer and the headline could still read
  // "All positions priced" while omitting real positions.
  pruning?: {
    upstreamRows: number;
    dustDropped: number;
    truncated: number;
    maxRowsPerChain: number;
    complete: boolean;
  };
  integrity?: {
    suspectCount: number;
    topPositionRatio: number | null;
    concentrated: boolean;
  };
  coverage: {
    operational: boolean;
    complete: boolean;
    hasGaps: boolean;
    degraded: string[];
    unavailable: string[];
    unconfigured: string[];
    pricing?: {
      provider: string;
      reachable: boolean;
      requested: number;
      resolved: number;
    };
  } | null;
}

function formatUsd(value: string | null): string {
  if (value === null) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: number >= 1_000 ? 0 : 2,
  }).format(number);
}

function formatUnits(amount: string | null, decimals: number | null): string {
  if (!amount) return "—";
  if (decimals === null || !/^[-+]?\d+$/.test(amount)) return amount;
  try {
    const negative = amount.startsWith("-");
    const digits = amount.replace(/^[-+]/, "").padStart(decimals + 1, "0");
    const head = decimals > 0 ? digits.slice(0, -decimals) : digits;
    const tail = decimals > 0 ? digits.slice(-decimals).replace(/0+$/, "").slice(0, 6) : "";
    const compact = `${negative ? "-" : ""}${head}${tail ? `.${tail}` : ""}`;
    const number = Number(compact);
    if (!Number.isFinite(number)) return compact;
    if (number !== 0 && Math.abs(number) < 0.000001) return "<0.000001";
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(number);
  } catch {
    return amount;
  }
}

function chainStateLabel(state: ChainState): string {
  if (state === "available") return "Live";
  if (state === "empty") return "No assets";
  if (state === "degraded") return "Partial";
  if (state === "unavailable") return "Unavailable";
  return "Not connected";
}

function stateColor(state: ChainState): string {
  if (state === "available") return "#8FE3C7";
  if (state === "empty") return "rgba(221,241,255,.44)";
  if (state === "degraded") return "#F3C879";
  if (state === "unavailable") return "#E98791";
  return "rgba(124,196,255,.38)";
}

function ChainGlyph({ chain, size = 28 }: { chain: OracleChain; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full border font-mono-ui text-[0.58rem] font-semibold uppercase tracking-[-0.04em]"
      style={{
        width: size,
        height: size,
        color: chain.accent,
        borderColor: `${chain.accent}55`,
        background: `${chain.accent}12`,
        boxShadow: `inset 0 0 14px ${chain.accent}0d`,
      }}
      aria-hidden
    >
      {chain.shortLabel.slice(0, 2)}
    </span>
  );
}

function LoadingPortfolio() {
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="h-32 animate-pulse border border-[#7CC4FF]/10 bg-[#7CC4FF]/[0.025]" />
      <div className="flex gap-2 overflow-hidden">
        {[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-9 w-28 shrink-0 animate-pulse bg-[#7CC4FF]/[0.06]" />)}
      </div>
      <div className="grid gap-px bg-[#7CC4FF]/10 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((item) => <div key={item} className="h-28 animate-pulse bg-[#0B1018]" />)}
      </div>
    </div>
  );
}

function EmptySetup({ onSave }: { onSave: (address: string) => void }) {
  const [address, setAddress] = useState("");
  return (
    <div className="grid min-h-[420px] place-items-center p-5">
      <div className="w-full max-w-lg border border-[#7CC4FF]/16 bg-[#0D141E]/92 p-5 sm:p-7">
        <span className="font-mono-ui text-[0.56rem] uppercase tracking-[0.18em] text-[#7CC4FF]/55">Portfolio setup</span>
        <h2 className="mt-3 text-xl font-medium text-[#EEF8FF]">Connect a public wallet</h2>
        <p className="mt-2 text-[0.76rem] leading-relaxed text-[#DDF1FF]/52">
          Oracle only reads public balances. Add one EVM address to scan Ethereum and every supported EVM chain. Solana and Bitcoin addresses can be added in Controls.
        </p>
        <label className="mt-5 block font-mono-ui text-[0.55rem] uppercase tracking-[0.15em] text-[#7CC4FF]/60" htmlFor="oracle-portfolio-address">EVM address</label>
        <input
          id="oracle-portfolio-address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="0x…"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="mt-2 h-11 w-full border border-[#7CC4FF]/18 bg-[#080D13] px-3 font-mono-ui text-[0.72rem] text-[#DDF1FF] outline-none transition-colors placeholder:text-[#7CC4FF]/24 focus:border-[#7CC4FF]/55"
        />
        <button
          type="button"
          disabled={!/^0x[a-fA-F0-9]{40}$/.test(address.trim())}
          onClick={() => onSave(address.trim())}
          className="mt-3 min-h-10 w-full bg-[#7CC4FF] px-4 font-mono-ui text-[0.6rem] font-semibold uppercase tracking-[0.14em] text-[#0B1018] transition-opacity disabled:cursor-not-allowed disabled:opacity-30"
        >
          Scan all chains
        </button>
      </div>
    </div>
  );
}

function AssetRow({ row, chain }: { row: PortfolioRow; chain: OracleChain }) {
  const symbol = row.symbol ?? row.collection ?? row.kind.replace(/-/g, " ");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#7CC4FF]/8 px-3.5 py-3 last:border-b-0 sm:px-4">
      <div className="flex min-w-0 items-center gap-3">
        <ChainGlyph chain={chain} size={32} />
        <div className="min-w-0">
          <div className="truncate text-[0.78rem] font-medium text-[#DDF1FF]">{symbol}</div>
          <div className="mt-0.5 truncate font-mono-ui text-[0.52rem] uppercase tracking-[0.13em] text-[#7CC4FF]/42">
            {chain.shortLabel} · {row.kind.replace(/-/g, " ")}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono-ui text-[0.72rem] text-[#E9F7FF]">{formatUnits(row.amount, row.decimals)}</div>
        <div className="mt-0.5 font-mono-ui text-[0.55rem] text-[#7CC4FF]/45">{row.priced ? formatUsd(row.valueUsd) : "Price unavailable"}</div>
      </div>
    </div>
  );
}

function ChainLedgerRow({ chain, onSelect }: { chain: PortfolioChain; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={() => { void haptic(5); onSelect(); }}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#7CC4FF]/8 px-3.5 py-0 text-left transition-colors last:border-b-0 hover:bg-[#7CC4FF]/[0.035] sm:px-4"
      style={{ minHeight: 44, boxShadow: `inset 1px 0 0 ${chain.accent}88` }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <ChainGlyph chain={chain} size={24} />
        <span className="truncate text-[0.78rem] font-medium text-[#DDF1FF]">{chain.shortLabel}</span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono-ui text-[0.49rem] uppercase tracking-[0.12em]" style={{ color: stateColor(chain.state) }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: stateColor(chain.state) }} />
          {chainStateLabel(chain.state)}
        </span>
      </div>
      <div className="flex items-center gap-4">
        <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.11em] text-[#7CC4FF]/38">
          {chain.assetCount} asset{chain.assetCount === 1 ? "" : "s"}
        </span>
        <span className="min-w-[92px] text-right font-mono-ui text-[0.72rem] text-[#E9F7FF]">
          {chain.valueUsd ? formatUsd(chain.valueUsd) : "—"}
        </span>
      </div>
    </button>
  );
}

/** Oracle-native multichain portfolio with one consistent chain tab system. */
export function PortfolioPane() {
  const [selected, setSelected] = useState("all");
  const [localEvm, setLocalEvm] = useState("");
  const [showQuiet, setShowQuiet] = useState(false);

  useEffect(() => {
    setLocalEvm(window.localStorage.getItem("oracle-portfolio-evm") ?? "");
  }, []);

  const portfolioPath = ORACLE_DATA_PLANE.routes.portfolio.path;
  const endpoint = localEvm ? `${portfolioPath}?evm=${encodeURIComponent(localEvm)}` : portfolioPath;
  const poll = usePolling<PortfolioPayload>(endpoint, 60_000);
  const payload = poll.data;
  const chainData = useMemo(() => {
    const reported = new Map((payload?.chains ?? []).map((chain) => [chain.id, chain]));
    return ORACLE_CHAINS.map((chain) => reported.get(chain.id) ?? ({ ...chain, state: "unavailable", assetCount: 0, valueUsd: null, unpricedCount: 0 } as PortfolioChain));
  }, [payload?.chains]);
  const activeChain = selected === "all" ? null : chainData.find((chain) => chain.id === selected) ?? null;
  const ledger = useMemo(() => {
    const rank: Record<ChainState, number> = { available: 0, degraded: 1, unavailable: 2, empty: 3, unconfigured: 4 };
    return [...chainData].sort((a, b) => {
      const valueA = Number(a.valueUsd ?? 0);
      const valueB = Number(b.valueUsd ?? 0);
      if (valueB !== valueA) return valueB - valueA;
      return rank[a.state] - rank[b.state];
    });
  }, [chainData]);
  const loudChains = useMemo(
    () => ledger.filter((chain) => chain.assetCount > 0 || chain.state === "degraded" || chain.state === "unavailable"),
    [ledger],
  );
  const quietChains = useMemo(
    () => ledger.filter((chain) => !loudChains.includes(chain)),
    [ledger, loudChains],
  );
  const liveChainCount = useMemo(
    () => chainData.filter((chain) => chain.state === "available").length,
    [chainData],
  );
  const visibleRows = useMemo(
    () => (payload?.rows ?? []).filter((row) => selected === "all" || row.chainId === selected),
    [payload?.rows, selected],
  );

  const saveAddress = (address: string) => {
    window.localStorage.setItem("oracle-portfolio-evm", address);
    setLocalEvm(address);
  };

  if (poll.loading && !payload) {
    return <div className="min-h-full bg-[#0B1018] text-[#DDF1FF]"><LoadingPortfolio /></div>;
  }

  if (poll.error && !payload) {
    return (
      <section className="grid min-h-full place-items-center bg-[#0B1018] px-5 text-[#DDF1FF]" aria-labelledby="portfolio-read-error-heading">
        <section className="w-full max-w-md border border-[#E98791]/22 bg-[#0D141E] p-6 text-center">
          <OracleMark size={42} className="mx-auto" />
          <div className="mt-4 font-mono-ui text-[0.54rem] uppercase tracking-[0.18em] text-[#E98791]/72">Portfolio read unavailable</div>
          <h1 id="portfolio-read-error-heading" className="mt-2 text-lg text-[#EEF8FF]">No balance data was returned.</h1>
          <p className="mt-2 text-[0.72rem] leading-relaxed text-[#DDF1FF]/48">
            Oracle did not substitute zeroes. Check the local data service or connection, then retry.
          </p>
          <div className="mt-3 font-mono-ui text-[0.56rem] text-[#F4B8BE]/72">{poll.error}</div>
          <button
            type="button"
            onClick={() => { void haptic(5); poll.reload(); }}
            className="mt-5 border border-[#7CC4FF]/28 px-4 py-2 font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#7CC4FF]"
          >
            Retry read
          </button>
        </section>
      </section>
    );
  }

  if (payload && !payload.configured && !localEvm) {
    return <section className="min-h-full bg-[#0B1018] text-[#DDF1FF]"><EmptySetup onSave={saveAddress} /></section>;
  }

  return (
    <section
      className="relative min-h-full overflow-hidden bg-[#0B1018] text-[#DDF1FF]"
      style={{ backgroundImage: "radial-gradient(circle at 76% 9%, rgba(124,196,255,.09), transparent 27%), linear-gradient(180deg, rgba(255,255,255,.012), transparent 24%)" }}
    >
      <div className="pointer-events-none absolute inset-0 opacity-[0.055]" aria-hidden style={{ backgroundImage: "linear-gradient(rgba(124,196,255,.16) 1px, transparent 1px), linear-gradient(90deg, rgba(124,196,255,.16) 1px, transparent 1px)", backgroundSize: "72px 72px", maskImage: "linear-gradient(to bottom, black, transparent 70%)" }} />
      <div className="relative mx-auto w-full max-w-[1280px] px-3 pb-9 pt-3 sm:px-5 lg:px-7 lg:pb-12 lg:pt-5">
        <header className="flex items-center gap-3 border-b border-[#7CC4FF]/10 pb-3">
          <OracleMark size={35} />
          <div className="min-w-0">
            <div className="font-mono-ui text-[0.53rem] uppercase tracking-[0.19em] text-[#7CC4FF]/46">Oracle portfolio</div>
            <h1 className="mt-0.5 truncate text-[0.9rem] font-medium text-[#EAF7FF]">Every chain. One view.</h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden font-mono-ui text-[0.48rem] uppercase tracking-[0.13em] text-[#7CC4FF]/40 sm:block">
              Keyless · Read-only · Prepare-only
            </span>
            <button
              type="button"
              onClick={() => { void haptic(5); poll.reload(); }}
              aria-label="Refresh portfolio"
              className="grid h-8 w-8 place-items-center rounded-full border border-[#7CC4FF]/12 text-[#7CC4FF]/58 transition-colors hover:border-[#7CC4FF]/32 hover:text-[#7CC4FF]"
            >
              <span className={poll.loading ? "animate-spin" : ""}><RefreshIcon width={14} height={14} /></span>
            </button>
          </div>
        </header>

        <section className="mt-5" aria-label="Aggregate portfolio balance">
          <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.2em] text-[#7CC4FF]/50">
            Total value · all chains
          </div>
          <div
            className="mt-1.5 text-[3.1rem] leading-[0.94] tracking-[-0.05em] text-[#EEF8FF] sm:text-[4.4rem] lg:text-[5rem]"
            style={{ fontFamily: '"Cormorant Garamond", Georgia, serif' }}
          >
            {formatUsd(payload?.totals.valueUsd ?? null)}
          </div>
          <div className="mt-2.5 font-mono-ui text-[0.56rem] uppercase tracking-[0.12em] text-[#7CC4FF]/52">
            {payload?.totals.complete
              ? "All positions priced"
              : /* Name every reason the headline is a subset. Reporting only the
                   unpriced count hid capped and suspect rows, which the route
                   already disclosed but nothing rendered. */
                `Partial total · ${[
                  (payload?.totals.unpricedCount ?? 0) > 0
                    ? `${payload?.totals.unpricedCount} unpriced excluded, not zeroed`
                    : null,
                  (payload?.pruning?.truncated ?? 0) > 0
                    ? `${payload?.pruning?.truncated} rows over the per-chain cap`
                    : null,
                  (payload?.integrity?.suspectCount ?? 0) > 0
                    ? `${payload?.integrity?.suspectCount} suspect excluded`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "source coverage incomplete"}`}
          </div>
          <div className="mt-1 font-mono-ui text-[0.56rem] uppercase tracking-[0.12em] text-[#7CC4FF]/38">
            {payload?.reachable ? payload.totals.assetCount : "—"} assets · {liveChainCount} of {chainData.length} chains live
          </div>
          <div className="mt-3 border-t border-[#7CC4FF]/10 pt-2.5 font-mono-ui text-[0.5rem] uppercase tracking-[0.11em] text-[#7CC4FF]/34">
            {payload?.coverage?.pricing
              ? `Coverage · ${payload.coverage.pricing.provider} resolved ${payload.coverage.pricing.resolved}/${payload.coverage.pricing.requested}`
              : "Coverage · pricing unavailable"}
            {payload?.coverage?.degraded?.length ? ` · ${payload.coverage.degraded.length} degraded sources` : ""}
            {payload?.coverage?.unavailable?.length ? ` · ${payload.coverage.unavailable.length} unavailable` : ""}
          </div>
        </section>

        <nav className="mt-4 overflow-x-auto border-y border-[#7CC4FF]/10 scrollbar-none" aria-label="Portfolio chains">
          <div className="flex min-w-max">
            <button
              type="button"
              onClick={() => { void haptic(5); setSelected("all"); }}
              aria-current={selected === "all" ? "page" : undefined}
              className={`relative flex h-11 items-center gap-2 px-4 font-mono-ui text-[0.58rem] uppercase tracking-[0.12em] transition-colors ${selected === "all" ? "text-[#DDF1FF]" : "text-[#7CC4FF]/45 hover:text-[#7CC4FF]"}`}
            >
              <span className="h-2 w-2 rounded-full border border-[#7CC4FF]/60" />
              All chains
              {selected === "all" && <span className="absolute inset-x-3 bottom-0 h-px bg-[#7CC4FF] shadow-[0_0_9px_#7CC4FF]" />}
            </button>
            {chainData.map((chain) => (
              <button
                key={chain.id}
                type="button"
                onClick={() => { void haptic(5); setSelected(chain.id); }}
                aria-current={selected === chain.id ? "page" : undefined}
                className={`relative flex h-11 items-center gap-2 border-l border-[#7CC4FF]/8 px-3.5 font-mono-ui text-[0.58rem] uppercase tracking-[0.1em] transition-colors ${selected === chain.id ? "text-[#DDF1FF]" : "text-[#7CC4FF]/45 hover:text-[#7CC4FF]"}`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: stateColor(chain.state) }} />
                {chain.shortLabel}
                {selected === chain.id && <span className="absolute inset-x-2 bottom-0 h-px shadow-[0_0_9px_currentColor]" style={{ background: chain.accent, color: chain.accent }} />}
              </button>
            ))}
          </div>
        </nav>

        {selected === "all" && (
          <div className="mt-4 grid gap-px border border-[#7CC4FF]/12 bg-[#7CC4FF]/10 sm:grid-cols-2">
            {[
              ["approvals", "Review approvals", "See what can spend your tokens"],
              ["tasks", "Ask Oracle", "Route a task to the specialist mesh"],
            ].map(([tab, title, subtitle]) => (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  void haptic(6);
                  window.dispatchEvent(new CustomEvent("lo-nav", { detail: { tab } }));
                }}
                className="flex min-h-[62px] items-center justify-between gap-3 bg-[#0B1018] px-4 py-3 text-left transition-colors hover:bg-[#0E1722]"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[0.78rem] font-medium text-[#DDF1FF]">{title}</span>
                  <span className="mt-0.5 block truncate font-mono-ui text-[0.5rem] uppercase tracking-[0.12em] text-[#7CC4FF]/40">{subtitle}</span>
                </span>
                <ChevronRightIcon width={15} height={15} className="shrink-0 text-[#7CC4FF]/48" />
              </button>
            ))}
          </div>
        )}

        {payload?.error && (
          <div className="mt-4 border border-[#E98791]/20 bg-[#E98791]/[0.045] px-4 py-3 text-[0.68rem] text-[#F4B8BE]">{payload.error}</div>
        )}

        {selected === "all" ? (
          <section className="mt-4" aria-labelledby="chain-overview-heading">
            <div className="mb-2.5 flex items-end justify-between gap-3">
              <div>
                <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.18em] text-[#7CC4FF]/43">Chain ledger</span>
                <h2 id="chain-overview-heading" className="mt-1 text-[0.92rem] font-medium text-[#DDF1FF]">Balance by chain</h2>
              </div>
              <span className="font-mono-ui text-[0.5rem] uppercase tracking-[0.12em] text-[#7CC4FF]/36">{chainData.length} networks</span>
            </div>
            <div className="overflow-hidden border border-[#7CC4FF]/12 bg-[#0B1018]/88">
              {loudChains.length > 0 ? (
                loudChains.map((chain) => <ChainLedgerRow key={chain.id} chain={chain} onSelect={() => setSelected(chain.id)} />)
              ) : (
                <div className="grid min-h-[120px] place-items-center px-5 text-center">
                  <p className="text-[0.78rem] text-[#DDF1FF]/62">No chain reported assets or problems</p>
                </div>
              )}
            </div>
            {quietChains.length > 0 && (
              <div className="mt-2 border border-[#7CC4FF]/10 bg-[#0C131C]/70">
                <button
                  type="button"
                  onClick={() => setShowQuiet((value) => !value)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left font-mono-ui text-[0.52rem] uppercase tracking-[0.12em] text-[#7CC4FF]/45"
                >
                  <span>{quietChains.length} chains, no assets or not connected</span>
                  <span>{showQuiet ? "hide" : "show"}</span>
                </button>
                {showQuiet && (
                  <div className="border-t border-[#7CC4FF]/8">
                    {quietChains.map((chain) => <ChainLedgerRow key={chain.id} chain={chain} onSelect={() => setSelected(chain.id)} />)}
                  </div>
                )}
              </div>
            )}
          </section>
        ) : (
          <section className="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]" aria-labelledby="selected-chain-heading">
            {activeChain && (
              <aside className="border border-[#7CC4FF]/12 bg-[#0D141E]/72 p-5">
                <ChainGlyph chain={activeChain} size={42} />
                <div className="mt-5 font-mono-ui text-[0.52rem] uppercase tracking-[0.17em] text-[#7CC4FF]/42">Selected chain</div>
                <h2 id="selected-chain-heading" className="mt-1.5 text-xl font-medium text-[#EEF8FF]">{activeChain.label}</h2>
                <div className="mt-5 grid grid-cols-2 gap-px bg-[#7CC4FF]/10">
                  <div className="bg-[#0B1018] p-3">
                    <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.12em] text-[#7CC4FF]/40">Assets</div>
                    <div className="mt-1.5 font-mono-ui text-lg text-[#DDF1FF]">{activeChain.assetCount}</div>
                  </div>
                  <div className="bg-[#0B1018] p-3">
                    <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.12em] text-[#7CC4FF]/40">Known value</div>
                    <div className="mt-1.5 font-mono-ui text-[0.8rem] text-[#DDF1FF]">{formatUsd(activeChain.valueUsd)}</div>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2 font-mono-ui text-[0.55rem] uppercase tracking-[0.12em]" style={{ color: stateColor(activeChain.state) }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: stateColor(activeChain.state) }} />
                  {chainStateLabel(activeChain.state)}
                </div>
              </aside>
            )}
            <div className="min-h-[260px] overflow-hidden border border-[#7CC4FF]/12 bg-[#0B1018]/88">
              <div className="border-b border-[#7CC4FF]/10 px-4 py-3 font-mono-ui text-[0.54rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Positions</div>
              {visibleRows.length > 0 && activeChain ? (
                visibleRows.map((row) => <AssetRow key={row.id} row={row} chain={activeChain} />)
              ) : (
                <div className="grid min-h-[210px] place-items-center px-5 text-center">
                  <div>
                    <p className="text-[0.8rem] text-[#DDF1FF]/68">{activeChain?.state === "unconfigured" ? "Wallet not connected" : activeChain?.state === "unavailable" ? "Chain read unavailable" : "No assets detected"}</p>
                    <p className="mt-1.5 font-mono-ui text-[0.53rem] uppercase tracking-[0.12em] text-[#7CC4FF]/36">Zero and unknown are kept separate</p>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {selected === "all" && (payload?.rows ?? []).length > 0 && (
          <PortfolioCharts
            rows={payload?.rows ?? []}
            chains={chainData}
            totalUsd={payload?.totals.valueUsd ?? null}
          />
        )}

        {selected === "all" && visibleRows.length > 0 && (
          <section className="mt-5" aria-labelledby="portfolio-assets-heading">
            <div className="mb-2.5">
              <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.18em] text-[#7CC4FF]/43">Detected positions</span>
              <h2 id="portfolio-assets-heading" className="mt-1 text-[0.92rem] font-medium text-[#DDF1FF]">Assets across chains</h2>
            </div>
            <div className="overflow-hidden border border-[#7CC4FF]/12 bg-[#0B1018]/88">
              {visibleRows.map((row) => {
                const chain = ORACLE_CHAINS.find((item) => item.id === row.chainId);
                return chain ? <AssetRow key={row.id} row={row} chain={chain} /> : null;
              })}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

export default PortfolioPane;
