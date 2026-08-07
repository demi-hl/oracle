"use client";

import { motion } from "framer-motion";
import { usePolling } from "@/components/usePolling";
import { RefreshIcon } from "@/components/panes/pane-icons";
import { ORACLE_CHAINS } from "@oracle-agent/contract";

type CatalogResponse = {
  configured?: boolean;
  reachable?: boolean;
  fetchedAt?: string;
  data?: unknown;
  catalog?: unknown;
  error?: string | null;
};

function countItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>((n, v) => n + countItems(v), 0);
  }
  return 0;
}

export function MarketsPane() {
  const poll = usePolling<CatalogResponse>("/api/oracle/catalog", 60_000);
  const payload = poll.data;
  const source = payload?.data ?? payload?.catalog;
  const catalogCount = countItems(source);

  return (
    <section className="mx-auto w-full max-w-6xl px-2 py-4 text-[#F4F9FE]" aria-labelledby="markets-heading">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="font-mono-ui text-[0.62rem] uppercase tracking-[0.18em] text-[#7CC4FF]">Markets</p>
          <h1 id="markets-heading" className="mt-2 font-display-ui text-4xl font-light leading-none tracking-[-0.05em]">route coverage</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[#9FB8D2]">
            Public route intelligence for wallet reads, quote surfaces, and prepare-only venues.
            Execution remains bounded by the local signer.
          </p>
        </div>
        <button
          type="button"
          onClick={poll.reload}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-[rgba(124,196,255,.14)] text-[#9FB8D2] transition-colors hover:text-[#7CC4FF]"
          aria-label="Refresh markets"
        >
          <RefreshIcon width={16} height={16} />
        </button>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        {/* A health chip must not read "yes" before evidence arrives. These are
            tri-state: an absent payload (first paint, failed fetch, unparsable
            body) is unknown, not healthy. Defaulting to yes made an unreachable
            service look reachable. */}
        <Stat
          label="configured"
          value={payload?.configured === undefined ? "unknown" : payload.configured ? "yes" : "no"}
          tone={payload?.configured === undefined ? "neutral" : payload.configured ? "ok" : "warn"}
        />
        <Stat
          label="reachable"
          value={payload?.reachable === undefined ? "unknown" : payload.reachable ? "yes" : "no"}
          tone={payload?.reachable === undefined ? "neutral" : payload.reachable ? "ok" : "warn"}
        />
        <Stat label="catalog entries" value={catalogCount ? String(catalogCount) : "pending"} tone="neutral" />
      </section>

      {payload?.error && (
        <div className="mt-4 rounded-2xl border border-[rgba(255,190,120,.22)] bg-[rgba(255,190,120,.06)] p-4 text-sm text-[#FFC789]">
          {payload.error}
        </div>
      )}

      <section className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ORACLE_CHAINS.map((chain) => (
          <motion.article
            key={chain.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24 }}
            className="rounded-2xl border border-[rgba(124,196,255,.14)] bg-[#0B1018]/70 p-4 backdrop-blur-xl"
          >
            <div className="mb-3 h-1 w-12 rounded-full" style={{ background: chain.accent }} />
            <div className="text-sm font-medium text-[#F4F9FE]">{chain.label}</div>
            <div className="mt-1 font-mono-ui text-[0.62rem] uppercase tracking-[0.12em] text-[#9FB8D2]">
              {chain.family === "evm" ? `chain ${chain.chainId}` : chain.family}
            </div>
          </motion.article>
        ))}
      </section>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "neutral" }) {
  const color = tone === "ok" ? "#7CC4FF" : tone === "warn" ? "#FFC789" : "#F4F9FE";
  return (
    <div className="rounded-2xl border border-[rgba(124,196,255,.14)] bg-[#0B1018]/70 p-4 backdrop-blur-xl">
      <div className="font-mono-ui text-[0.58rem] uppercase tracking-[0.15em] text-[#9FB8D2]">{label}</div>
      <div className="mt-2 text-2xl font-light" style={{ color }}>{value}</div>
    </div>
  );
}
