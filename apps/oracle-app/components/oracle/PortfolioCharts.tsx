"use client";

import { useMemo, useState } from "react";

type ChainState = "available" | "empty" | "degraded" | "unavailable" | "unconfigured";
type OracleChainFamily = "evm" | "solana" | "bitcoin" | "hyperliquid";

interface OracleChain {
  id: string;
  label: string;
  shortLabel: string;
  family: OracleChainFamily;
  chainId: number | null;
  nativeSymbol: string;
  accent: string;
}

export interface PortfolioRow {
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

export interface PortfolioChain extends OracleChain {
  state: ChainState;
  assetCount: number;
  valueUsd: string | null;
  unpricedCount: number;
}

export interface PortfolioPayload {
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
  coverage: {
    operational: boolean;
    complete: boolean;
    hasGaps: boolean;
    degraded: string[];
    unavailable: string[];
    unconfigured: string[];
    pricing?: { provider: string; reachable: boolean; requested: number; resolved: number };
  } | null;
}

export interface PortfolioChartsProps {
  rows: PortfolioRow[];
  chains: PortfolioChain[];
  totalUsd: string | null;
}

function numericUsd(value: string | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatUsd(value: string | null): string {
  const number = numericUsd(value);
  if (number === null) return "Value unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: number >= 1_000 ? 0 : 2,
  }).format(number);
}

function EmptyChart() {
  return (
    <div className="grid min-h-[260px] place-items-center border border-[#7CC4FF]/14 bg-[#0B1018] px-5 text-center">
      <div>
        <p className="text-[0.8rem] text-[#F4F9FE]/68">No priced portfolio data</p>
        <p className="mt-1.5 font-mono-ui text-[0.53rem] uppercase tracking-[0.12em] text-[#9FB8D2]/48">
          Allocation and value breakdown are unavailable
        </p>
      </div>
    </div>
  );
}

export function PortfolioCharts({ rows, chains, totalUsd }: PortfolioChartsProps) {
  const [activeChainId, setActiveChainId] = useState<string | null>(null);
  const chainById = useMemo(() => new Map(chains.map((chain) => [chain.id, chain])), [chains]);
  const allocation = useMemo(() => {
    const values = new Map<string, number>();
    for (const row of rows) {
      const value = numericUsd(row.valueUsd);
      if (value !== null && value > 0 && chainById.has(row.chainId)) {
        values.set(row.chainId, (values.get(row.chainId) ?? 0) + value);
      }
    }
    const total = [...values.values()].reduce((sum, value) => sum + value, 0);
    return chains
      .map((chain) => ({ chain, value: values.get(chain.id) ?? 0 }))
      .filter((item) => item.value > 0)
      .map((item) => ({ ...item, percent: total > 0 ? (item.value / total) * 100 : 0 }));
  }, [chainById, chains, rows]);

  const topAssets = useMemo(() => [...rows]
    .sort((left, right) => {
      const leftValue = numericUsd(left.valueUsd);
      const rightValue = numericUsd(right.valueUsd);
      if (leftValue === null) return rightValue === null ? 0 : 1;
      if (rightValue === null) return -1;
      return rightValue - leftValue;
    })
    .slice(0, 8), [rows]);

  const knownTotal = numericUsd(totalUsd);
  if (rows.length === 0 || knownTotal === null || allocation.length === 0) return <EmptyChart />;

  const active = allocation.find((item) => item.chain.id === activeChainId) ?? null;
  const circumference = 2 * Math.PI * 42;
  const allocationSegments = allocation.reduce<Array<(typeof allocation)[number] & { offsetPercent: number }>>(
    (segments, item) => {
      const offsetPercent = segments.reduce((sum, segment) => sum + segment.percent, 0);
      segments.push({ ...item, offsetPercent });
      return segments;
    },
    [],
  );
  const donutHeight = 170 + Math.ceil(allocation.length / 2) * 17;
  const rowHeight = 38;
  const chartHeight = Math.max(94, topAssets.length * rowHeight + 18);
  const maxAssetValue = Math.max(0, ...topAssets.map((row) => numericUsd(row.valueUsd) ?? 0));

  return (
    <section className="grid gap-px overflow-hidden border border-[#7CC4FF]/14 bg-[#7CC4FF]/14 lg:grid-cols-[minmax(280px,0.72fr)_minmax(420px,1.28fr)]" aria-label="Portfolio charts">
      <div className="bg-[#0B1018] p-4 sm:p-5">
        <div className="font-mono-ui text-[0.52rem] uppercase tracking-[0.18em] text-[#7CC4FF]/52">Chain allocation</div>
        <svg role="img" aria-label="Portfolio value allocation by chain" viewBox={`0 0 260 ${donutHeight}`} className="mx-auto mt-2 block w-full max-w-[310px]">
          <circle cx="130" cy="100" r="42" fill="none" stroke="rgba(124,196,255,.08)" strokeWidth="18" />
          {allocationSegments.map(({ chain, percent, offsetPercent }) => {
            const length = (percent / 100) * circumference;
            return (
              <circle
                key={chain.id}
                cx="130"
                cy="100"
                r="42"
                fill="none"
                stroke={chain.accent}
                strokeWidth={activeChainId === chain.id ? 21 : 18}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-(offsetPercent / 100) * circumference}
                strokeLinecap="butt"
                transform="rotate(-90 130 100)"
                tabIndex={0}
                aria-label={`${chain.label}, ${percent.toFixed(1)} percent`}
                onMouseEnter={() => setActiveChainId(chain.id)}
                onMouseLeave={() => setActiveChainId(null)}
                onFocus={() => setActiveChainId(chain.id)}
                onBlur={() => setActiveChainId(null)}
                className="cursor-default outline-none transition-[stroke-width] focus:stroke-[21px]"
              />
            );
          })}
          <text x="130" y="96" textAnchor="middle" fill="#9FB8D2" fontSize="8" letterSpacing="1.4">{active ? active.chain.shortLabel.toUpperCase() : "KNOWN VALUE"}</text>
          <text x="130" y="111" textAnchor="middle" fill="#F4F9FE" fontSize="11" fontWeight="500">{active ? `${active.percent.toFixed(1)}%` : formatUsd(totalUsd)}</text>
          {allocation.map(({ chain, percent }, index) => {
            const column = index % 2;
            const line = Math.floor(index / 2);
            const x = column === 0 ? 18 : 142;
            const y = 166 + line * 17;
            return (
              <g key={`legend-${chain.id}`}>
                <circle cx={x} cy={y - 3} r="3" fill={chain.accent} />
                <text x={x + 8} y={y} fill="#9FB8D2" fontSize="7.5">{chain.shortLabel} {percent.toFixed(1)}%</text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="bg-[#0B1018] p-4 sm:p-5">
        <div className="font-mono-ui text-[0.52rem] uppercase tracking-[0.18em] text-[#7CC4FF]/52">Largest positions</div>
        <svg role="img" aria-label="Top eight portfolio assets by known value" viewBox={`0 0 620 ${chartHeight}`} className="mt-3 block w-full" preserveAspectRatio="xMidYMid meet">
          {topAssets.map((row, index) => {
            const value = numericUsd(row.valueUsd);
            const width = value !== null && maxAssetValue > 0 ? (value / maxAssetValue) * 310 : 0;
            const y = index * rowHeight + 8;
            const symbol = row.symbol ?? row.collection ?? row.kind.replace(/-/g, " ");
            const color = chainById.get(row.chainId)?.accent ?? "#7CC4FF";
            return (
              <g key={row.id}>
                <text x="0" y={y + 15} fill="#F4F9FE" fontSize="11" fontWeight="500">{symbol.slice(0, 18)}</text>
                <rect x="126" y={y + 3} width="310" height="15" fill="rgba(124,196,255,.055)" />
                {value !== null && <rect x="126" y={y + 3} width={width} height="15" fill={color} opacity="0.78" />}
                <text x="610" y={y + 15} textAnchor="end" fill={value === null ? "#9FB8D2" : "#F4F9FE"} fontSize="10">
                  {value === null ? "Unpriced" : formatUsd(row.valueUsd)}
                </text>
                <line x1="0" x2="620" y1={y + 28} y2={y + 28} stroke="rgba(124,196,255,.10)" />
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

export default PortfolioCharts;
