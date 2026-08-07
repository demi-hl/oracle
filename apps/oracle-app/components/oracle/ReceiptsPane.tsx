"use client";

import { useEffect, useMemo, useState } from "react";
import { MAX_RECEIPTS, listReceipts, saveReceipt, type OracleReceipt } from "./surfaceStorage";

const ORACLE_BLUE = "#7CC4FF";
const ORACLE_MUTE = "#9FB8D2";
const HAIRLINE = "rgba(124,196,255,.14)";

function compact(value: string | null | undefined): string {
  if (!value) return "none";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  return String(value);
}

async function copy(text: string, setStatus: (value: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus("copied");
  } catch {
    setStatus("copy blocked");
  }
}

function sampleReceipt(): OracleReceipt {
  const createdAt = new Date().toISOString();
  return {
    receiptId: `sample-${Date.now().toString(36)}`,
    phase: "prepare",
    createdAt,
    intent: { chain: "Base", sell: "ETH", buy: "USDC", amount: "0.25" },
    route: { venue: "public prepare", chainId: "base", priceImpactPct: 0.04 },
    decodedAction: { type: "swap.prepare", sellAmount: "0.25", expectedBuyAmount: "sample" },
    boundaryStamps: [
      { name: "browser holds no key", ok: true, kind: "architectural" as const },
      { name: "prepared only", ok: true, kind: "architectural" as const },
      { name: "local signer review required", ok: true, kind: "architectural" as const },
    ],
    allowlistHits: ["public prepare plane", "local signer boundary"],
    prepareHash: "sample-prepare-hash",
    txHash: null,
    balances: null,
    summary: "Sample prepare receipt. No transaction hash.",
  };
}

function ReceiptCard({ receipt, selected, onSelect }: { receipt: OracleReceipt; selected: boolean; onSelect: () => void }) {
  const failed = receipt.boundaryStamps.filter((check) => !check.ok).length;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="grid gap-3 border-b border-[#7CC4FF]/10 p-4 text-left transition-colors last:border-b-0 hover:bg-[#7CC4FF]/[0.035]"
      style={{ background: selected ? "rgba(124,196,255,.055)" : "transparent" }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono-ui text-[0.5rem] uppercase tracking-[0.16em] text-[#7CC4FF]/46">{receipt.phase}</span>
        <span className="font-mono-ui text-[0.5rem] uppercase tracking-[0.12em]" style={{ color: failed ? "#F4B8BE" : ORACLE_BLUE }}>
          {failed ? `${failed} failed` : "boundary held"}
        </span>
      </div>
      <div>
        <div className="text-[0.84rem] text-[#EEF8FF]">{fieldValue(receipt.decodedAction.type)}</div>
        <div className="mt-1 font-mono-ui text-[0.56rem] uppercase tracking-[0.1em] text-[#7CC4FF]/38">{compact(receipt.receiptId)}</div>
      </div>
      <p className="line-clamp-2 text-[0.66rem] leading-relaxed text-[#DDF1FF]/46">{receipt.summary}</p>
    </button>
  );
}

export function ReceiptsPane() {
  const [receipts, setReceipts] = useState<OracleReceipt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const load = () => {
      const next = listReceipts();
      setReceipts(next);
      setSelectedId((current) => current ?? next[0]?.receiptId ?? null);
    };
    load();
    window.addEventListener("oracle-receipts-updated", load);
    return () => window.removeEventListener("oracle-receipts-updated", load);
  }, []);

  const selected = useMemo(
    () => receipts.find((item) => item.receiptId === selectedId) ?? receipts[0] ?? null,
    [receipts, selectedId],
  );
  const stampsHeld = selected?.boundaryStamps.filter((check) => check.ok).length ?? 0;
  const stampsFailed = selected?.boundaryStamps.filter((check) => !check.ok).length ?? 0;

  return (
    <section className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 overflow-y-auto p-4 text-[#DDF1FF] sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[#7CC4FF]/10 pb-5">
        <div>
          <p className="font-mono-ui text-[0.56rem] uppercase tracking-[0.2em] text-[#7CC4FF]/58">Receipt Explorer</p>
          <h1 className="mt-2 font-display-ui text-[2.15rem] leading-none tracking-[-0.05em] text-[#EEF8FF] sm:text-[3rem]">
            every prepared swap gets a trail
          </h1>
          <p className="mt-3 max-w-2xl text-[0.78rem] leading-relaxed text-[#DDF1FF]/56">
            Receipts show intent, route, decoded action, boundary stamps, allowlist hits, prepare hash, optional transaction hash, and before or after balances when execution supplies them. Swap prepares are recorded here; revoke prepares are not. The newest {MAX_RECEIPTS} are kept in this browser.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              const next = saveReceipt(sampleReceipt());
              setReceipts(next);
              setSelectedId(next[0]?.receiptId ?? null);
              setStatus("sample added");
            }}
            className="border border-[#7CC4FF]/18 px-3 py-2 font-mono-ui text-[0.55rem] uppercase tracking-[0.12em] text-[#9FB8D2]"
          >
            Add sample
          </button>
          <button
            type="button"
            onClick={() => copy(JSON.stringify(receipts, null, 2), setStatus)}
            className="border border-[#7CC4FF]/22 px-3 py-2 font-mono-ui text-[0.55rem] uppercase tracking-[0.12em] text-[#7CC4FF]"
          >
            Export JSON
          </button>
        </div>
      </header>

      <section className="grid min-h-[520px] overflow-hidden border border-[#7CC4FF]/12 bg-[#0B1018]/82 lg:grid-cols-[340px_1fr]">
        <aside className="border-b border-[#7CC4FF]/10 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between border-b border-[#7CC4FF]/10 px-4 py-3">
            <span className="font-mono-ui text-[0.54rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">History</span>
            <span className="font-mono-ui text-[0.54rem] uppercase tracking-[0.16em] text-[#DDF1FF]/46">{receipts.length}</span>
          </div>
          {receipts.length === 0 ? (
            <div className="grid min-h-[240px] place-items-center px-5 text-center">
              <div>
                <p className="text-[0.82rem] text-[#DDF1FF]/72">No receipts yet</p>
                <p className="mt-1.5 text-[0.66rem] leading-relaxed text-[#DDF1FF]/42">Prepare a swap or add a sample to inspect the receipt schema.</p>
              </div>
            </div>
          ) : (
            <div>{receipts.map((receipt) => <ReceiptCard key={receipt.receiptId} receipt={receipt} selected={receipt.receiptId === selected?.receiptId} onSelect={() => setSelectedId(receipt.receiptId)} />)}</div>
          )}
        </aside>

        <main className="min-w-0 p-4 sm:p-5">
          {selected ? (
            <div className="grid gap-4">
              <section className="grid gap-px overflow-hidden border border-[#7CC4FF]/10 bg-[#7CC4FF]/10 sm:grid-cols-4">
                {[
                  ["phase", selected.phase],
                  ["boundary", `${stampsHeld} held, ${stampsFailed} failed`],
                  ["tx", selected.txHash ? compact(selected.txHash) : "none"],
                  ["created", new Date(selected.createdAt).toLocaleString()],
                ].map(([label, value]) => (
                  <div key={label} className="bg-[#0B1018] p-3">
                    <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.16em] text-[#7CC4FF]/42">{label}</div>
                    <div className="mt-1 text-[0.76rem] text-[#DDF1FF]">{value}</div>
                  </div>
                ))}
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                <DetailBlock title="Intent" rows={selected.intent} />
                <DetailBlock title="Route" rows={selected.route} />
                <DetailBlock title="Decoded action" rows={selected.decodedAction} />
                <DetailBlock title="Hashes" rows={{ receiptId: selected.receiptId, prepareHash: selected.prepareHash, txHash: selected.txHash ?? "none" }} />
              </section>

              <section className="grid gap-4 lg:grid-cols-2">
                <div className="border border-[#7CC4FF]/12 p-4">
                  <h2 className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Boundary stamps</h2>
                  <p className="mt-1.5 text-[0.66rem] leading-relaxed text-[#DDF1FF]/44">
                    Architectural stamps restate guarantees this build enforces for every prepare. Only evaluated stamps were computed for this intent.
                  </p>
                  <div className="mt-3 grid gap-2">
                    {selected.boundaryStamps.map((check) => (
                      <div key={check.name} className="flex items-center justify-between gap-3 border border-[#7CC4FF]/10 px-3 py-2">
                        <span className="text-[0.72rem] text-[#DDF1FF]/70">{check.name}</span>
                        <span className="flex items-center gap-2">
                          <span className="font-mono-ui text-[0.46rem] uppercase tracking-[0.1em] text-[#DDF1FF]/34">{check.kind}</span>
                          <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.12em]" style={{ color: check.ok ? ORACLE_BLUE : "#F4B8BE" }}>{check.ok ? "held" : "failed"}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="border border-[#7CC4FF]/12 p-4">
                  <h2 className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Architecture planes</h2>
                  <p className="mt-1.5 text-[0.66rem] leading-relaxed text-[#DDF1FF]/44">
                    Names of the planes this receipt was built on. Not the result of an allowlist engine.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selected.allowlistHits.map((hit) => (
                      <span key={hit} className="border border-[#7CC4FF]/14 px-2 py-1 font-mono-ui text-[0.52rem] uppercase tracking-[0.1em] text-[#DDF1FF]/58">{hit}</span>
                    ))}
                  </div>
                </div>
              </section>

              <pre className="max-h-[300px] overflow-auto border border-[#7CC4FF]/12 bg-[#080D13] p-4 text-[0.66rem] leading-relaxed text-[#DDF1FF]/68"><code>{JSON.stringify(selected, null, 2)}</code></pre>
            </div>
          ) : (
            <div className="grid min-h-[420px] place-items-center text-center text-[#DDF1FF]/52">Select a receipt to inspect.</div>
          )}
        </main>
      </section>
      <div className="font-mono-ui text-[0.52rem] uppercase tracking-[0.14em] text-[#7CC4FF]/42">{status || "local browser history only"}</div>
    </section>
  );
}

function DetailBlock({ title, rows }: { title: string; rows: Record<string, unknown> }) {
  return (
    <div className="border border-[#7CC4FF]/12 p-4">
      <h2 className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">{title}</h2>
      <dl className="mt-3 grid gap-2">
        {Object.entries(rows).map(([key, value]) => (
          <div key={key} className="grid grid-cols-[120px_1fr] gap-3 border-b border-[#7CC4FF]/8 pb-2 last:border-b-0 last:pb-0">
            <dt className="font-mono-ui text-[0.52rem] uppercase tracking-[0.1em] text-[#7CC4FF]/36">{key}</dt>
            <dd className="min-w-0 break-words font-mono-ui text-[0.66rem] text-[#DDF1FF]/72">{fieldValue(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default ReceiptsPane;
