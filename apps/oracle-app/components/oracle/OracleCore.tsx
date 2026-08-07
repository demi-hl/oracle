"use client";

import { useId } from "react";
import { motion, useReducedMotion } from "framer-motion";

export interface OracleCoreSpecialist {
  id: string;
  label: string;
  detail?: string;
}

export interface OracleCoreProps {
  specialists?: OracleCoreSpecialist[];
  loading?: boolean;
  unavailable?: boolean;
  className?: string;
}

const NODES = [
  { x: 704, y: 82, anchor: "start" as const },
  { x: 808, y: 140, anchor: "start" as const },
  { x: 835, y: 224, anchor: "start" as const },
  { x: 790, y: 310, anchor: "start" as const },
  { x: 675, y: 354, anchor: "start" as const },
  { x: 642, y: 185, anchor: "start" as const },
];

function shortLabel(label: string): string {
  const clean = label.trim();
  return clean.length > 20 ? `${clean.slice(0, 19)}...` : clean;
}

/**
 * The visual product model: user -> task -> Oracle -> specialist mesh.
 * Catalog labels are supplied by the caller; the component never invents a
 * profile when the catalog is loading, unavailable, or empty.
 */
export function OracleCore({
  specialists = [],
  loading = false,
  unavailable = false,
  className = "",
}: OracleCoreProps) {
  const reducedMotion = useReducedMotion();
  const rawId = useId().replace(/:/g, "");
  const glowId = `oracle-core-glow-${rawId}`;
  const haloId = `oracle-core-halo-${rawId}`;
  const visibleSpecialists = specialists.slice(0, NODES.length);
  const meshState = loading
    ? "discovering catalog"
    : unavailable
      ? "catalog unavailable"
      : visibleSpecialists.length > 0
        ? `${specialists.length} catalog profile${specialists.length === 1 ? "" : "s"}`
        : "no profiles reported";

  return (
    <div className={`relative w-full ${className}`}>
      <div
        className="px-2 py-5 sm:hidden"
        role="img"
        aria-label={`You give Oracle a task. Oracle routes it through the specialist mesh: ${meshState}.`}
      >
        <div className="flex items-center justify-center gap-2.5" aria-hidden>
          <span className="flex flex-col items-center gap-1.5">
            <span className="grid h-9 w-9 place-items-center rounded-full border border-[#7CC4FF]/30 bg-[#7CC4FF]/[0.035]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#ECE7DA]" />
            </span>
            <span className="font-mono-ui text-[0.48rem] tracking-[0.16em] text-[#7CC4FF]/65">YOU</span>
          </span>
          <span className="mb-4 h-px w-7 bg-[#7CC4FF]/35" />
          <span className="flex flex-col items-center gap-1.5">
            <span className="grid h-9 w-9 place-items-center border border-[#7CC4FF]/30 bg-[#7CC4FF]/[0.035]">
              <span className="flex w-4 flex-col gap-1">
                <span className="h-px w-full bg-[#ECE7DA]/70" />
                <span className="h-px w-3 bg-[#ECE7DA]/45" />
                <span className="h-px w-full bg-[#ECE7DA]/55" />
              </span>
            </span>
            <span className="font-mono-ui text-[0.48rem] tracking-[0.16em] text-[#7CC4FF]/65">TASK</span>
          </span>
          <span className="mb-4 h-px w-7 bg-[#7CC4FF]/45" />
          <span className="flex flex-col items-center gap-1.5">
            <span
              className="grid h-[72px] w-[72px] place-items-center rounded-full border border-[#7CC4FF]/45 bg-[#7CC4FF]/[0.055]"
              style={{ boxShadow: "0 0 42px rgba(124,196,255,0.16), inset 0 0 24px rgba(124,196,255,0.05)" }}
            >
              <span className="grid h-8 w-8 rotate-45 place-items-center border border-[#7CC4FF]/65">
                <span className="h-2 w-2 rounded-full bg-[#ECE7DA] shadow-[0_0_12px_rgba(236,231,218,0.7)]" />
              </span>
            </span>
            <span className="font-mono-ui text-[0.5rem] tracking-[0.16em] text-[#ECE7DA]">ORACLE</span>
          </span>
        </div>

        <div
          className="mx-auto mt-1 h-7 w-px"
          style={{ background: "linear-gradient(to bottom, rgba(124,196,255,0.45), rgba(124,196,255,0.1))" }}
          aria-hidden
        />
        <div className="border-y border-[var(--fable-line)] py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono-ui text-[0.5rem] tracking-[0.16em] text-[#7CC4FF]/70">SPECIALIST MESH</span>
            <span className="truncate text-right font-mono-ui text-[0.46rem] uppercase tracking-[0.1em] text-[#8B98A8]/70">{meshState}</span>
          </div>
          {visibleSpecialists.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-x-4">
              {visibleSpecialists.map((specialist) => (
                <div key={specialist.id} className="min-w-0 border-b border-[var(--fable-line)] py-2 last:border-b-0 [&:nth-last-child(2)]:border-b-0">
                  <span className="flex items-center gap-1.5 text-[0.64rem] text-[#C3CDD9]">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#7CC4FF]" />
                    <span className="truncate">{specialist.label}</span>
                  </span>
                  {specialist.detail && (
                    <span className="mt-1 block truncate pl-3 font-mono-ui text-[0.44rem] uppercase tracking-[0.1em] text-[#7CC4FF]/42">
                      {specialist.detail}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <svg
        viewBox="0 0 920 420"
        role="img"
        aria-labelledby={`${rawId}-title ${rawId}-desc`}
        className="hidden h-auto w-full overflow-visible sm:block"
      >
        <title id={`${rawId}-title`}>Oracle routing mesh</title>
        <desc id={`${rawId}-desc`}>
          A user gives Oracle a task. Oracle routes it through a bounded specialist mesh.
        </desc>
        <defs>
          <radialGradient id={haloId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#7CC4FF" stopOpacity="0.34" />
            <stop offset="48%" stopColor="#4CAFFF" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#060A10" stopOpacity="0" />
          </radialGradient>
          <filter id={glowId} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="7" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id={`${rawId}-route`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#7CC4FF" stopOpacity="0.18" />
            <stop offset="56%" stopColor="#7CC4FF" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#7CC4FF" stopOpacity="0.2" />
          </linearGradient>
        </defs>

        <g opacity="0.16" aria-hidden>
          <path d="M18 54H902M18 210H902M18 366H902" stroke="#7CC4FF" strokeWidth="0.5" strokeDasharray="2 10" />
          <path d="M162 28V392M460 28V392M760 28V392" stroke="#7CC4FF" strokeWidth="0.5" strokeDasharray="2 10" />
        </g>

        <motion.path
          d="M104 210H214"
          stroke={`url(#${rawId}-route)`}
          strokeWidth="1.4"
          strokeDasharray="4 7"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.8, ease: "easeOut" }}
        />
        <motion.path
          d="M268 210C326 210 342 210 382 210"
          stroke={`url(#${rawId}-route)`}
          strokeWidth="1.5"
          strokeDasharray="4 7"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: reducedMotion ? 0 : 0.9, delay: reducedMotion ? 0 : 0.15, ease: "easeOut" }}
        />

        {NODES.map((node, index) => (
          <motion.path
            key={`route-${index}`}
            d={`M536 210C588 210 ${node.x - 54} ${node.y} ${node.x - 10} ${node.y}`}
            fill="none"
            stroke="#7CC4FF"
            strokeWidth="0.9"
            strokeOpacity={visibleSpecialists[index] ? 0.46 : 0.16}
            strokeDasharray={visibleSpecialists[index] ? "3 6" : "2 9"}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{
              duration: reducedMotion ? 0 : 0.7,
              delay: reducedMotion ? 0 : 0.35 + index * 0.08,
              ease: "easeOut",
            }}
          />
        ))}

        <g>
          <circle cx="74" cy="210" r="29" fill="#7CC4FF" fillOpacity="0.035" stroke="#7CC4FF" strokeOpacity="0.28" />
          <circle cx="74" cy="210" r="5" fill="#ECE7DA" />
          <path d="M58 232c4-10 10-15 16-15s12 5 16 15" stroke="#7CC4FF" strokeOpacity="0.75" fill="none" />
          <text x="74" y="258" textAnchor="middle" fill="#7CC4FF" fillOpacity="0.78" fontSize="10" letterSpacing="2.4" fontFamily="var(--theme-font-mono), ui-monospace, monospace">
            YOU
          </text>
        </g>

        <g>
          <rect x="214" y="181" width="54" height="58" rx="14" fill="#7CC4FF" fillOpacity="0.045" stroke="#7CC4FF" strokeOpacity="0.32" />
          <path d="M229 198h24M229 207h18M229 216h21" stroke="#ECE7DA" strokeOpacity="0.76" strokeLinecap="round" />
          <text x="241" y="258" textAnchor="middle" fill="#7CC4FF" fillOpacity="0.78" fontSize="10" letterSpacing="2.4" fontFamily="var(--theme-font-mono), ui-monospace, monospace">
            TASK
          </text>
        </g>

        <g>
          <circle cx="460" cy="210" r="116" fill={`url(#${haloId})`} />
          {!reducedMotion && (
            <motion.circle
              cx="460"
              cy="210"
              r="74"
              fill="none"
              stroke="#7CC4FF"
              strokeWidth="0.8"
              initial={{ opacity: 0.12, scale: 0.94 }}
              animate={{ opacity: [0.12, 0.34, 0.12], scale: [0.94, 1.04, 0.94] }}
              transition={{ duration: 4.8, repeat: Infinity, ease: "easeInOut" }}
              style={{ transformOrigin: "460px 210px" }}
            />
          )}
          <circle cx="460" cy="210" r="58" fill="#060A10" fillOpacity="0.74" stroke="#7CC4FF" strokeOpacity="0.38" strokeWidth="1" />
          <ellipse cx="460" cy="210" rx="47" ry="17" fill="none" stroke="#7CC4FF" strokeOpacity="0.58" transform="rotate(-30 460 210)" />
          <ellipse cx="460" cy="210" rx="47" ry="17" fill="none" stroke="#7CC4FF" strokeOpacity="0.4" transform="rotate(30 460 210)" />
          <path d="m460 180 20 30-20 30-20-30 20-30Z" fill="#7CC4FF" fillOpacity="0.07" stroke="#7CC4FF" strokeOpacity="0.74" />
          <circle cx="460" cy="210" r="6" fill="#ECE7DA" filter={`url(#${glowId})`} />
          <text x="460" y="290" textAnchor="middle" fill="#ECE7DA" fontSize="16" letterSpacing="4" fontFamily="var(--theme-font-mono), ui-monospace, monospace">
            ORACLE
          </text>
          <text x="460" y="309" textAnchor="middle" fill="#7CC4FF" fillOpacity="0.62" fontSize="8.5" letterSpacing="2" fontFamily="var(--theme-font-mono), ui-monospace, monospace">
            ROUTE  /  BOUND  /  OBSERVE
          </text>
        </g>

        <g>
          <text x="666" y="42" fill="#7CC4FF" fillOpacity="0.7" fontSize="9" letterSpacing="2.3" fontFamily="var(--theme-font-mono), ui-monospace, monospace">
            SPECIALIST MESH
          </text>
          <text x="666" y="57" fill="#8B98A8" fillOpacity="0.7" fontSize="8" letterSpacing="1.1" fontFamily="var(--theme-font-mono), ui-monospace, monospace">
            {meshState.toUpperCase()}
          </text>
        </g>

        {NODES.map((node, index) => {
          const specialist = visibleSpecialists[index];
          return (
            <g key={specialist?.id ?? `empty-${index}`} opacity={specialist ? 1 : 0.42}>
              <circle
                cx={node.x}
                cy={node.y}
                r={specialist ? 9 : 5}
                fill="#060A10"
                stroke="#7CC4FF"
                strokeWidth="1"
                strokeOpacity={specialist ? 0.86 : 0.28}
              />
              {specialist && <circle cx={node.x} cy={node.y} r="2.5" fill="#7CC4FF" />}
              {specialist && (
                <>
                  <text
                    x={node.x + 16}
                    y={node.y - 2}
                    textAnchor={node.anchor}
                    fill="#ECE7DA"
                    fontSize="10"
                    letterSpacing="0.7"
                    fontFamily="var(--theme-font-sans), system-ui, sans-serif"
                  >
                    {shortLabel(specialist.label)}
                  </text>
                  {specialist.detail && (
                    <text
                      x={node.x + 16}
                      y={node.y + 12}
                      textAnchor={node.anchor}
                      fill="#7CC4FF"
                      fillOpacity="0.5"
                      fontSize="7.5"
                      letterSpacing="0.6"
                      fontFamily="var(--theme-font-mono), ui-monospace, monospace"
                    >
                      {shortLabel(specialist.detail).toUpperCase()}
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
