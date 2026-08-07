"use client";

import { useEffect, useState } from "react";

interface CliResult {
  code: number;
  command: string;
  stdout?: string;
  stderr?: string;
}

declare global {
  interface Window {
    oracleDesktop?: {
      runCli(line: string): Promise<CliResult>;
    };
  }
}

const QUICK = [
  "oracle --help",
  "oracle version",
  "oracle data health",
  "oracle data catalog",
  "oracle chain list",
  "oracle route --help",
  "oracle prepare --help",
  "oracle gate status",
];

function Output({ result, busy }: { result: CliResult | null; busy: boolean }) {
  let text = "select a command or type oracle --help";
  if (busy) text = "running…";
  else if (result) text = [result.stdout, result.stderr].filter(Boolean).join("\n") || `exit ${result.code}`;

  return (
    <pre className="min-h-[340px] overflow-auto whitespace-pre-wrap break-words border border-[var(--fable-line)] bg-[#05080D] p-4 font-mono-ui text-[0.68rem] leading-relaxed text-[var(--fable-ink)] shadow-[inset_0_0_0_1px_rgba(124,196,255,.04)]">
      {text}
    </pre>
  );
}

export function CliRuntimePane() {
  const [line, setLine] = useState("oracle --help");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CliResult | null>(null);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    setAvailable(Boolean(window.oracleDesktop?.runCli));
  }, []);

  const run = async (nextLine = line) => {
    const command = nextLine.trim() || "oracle --help";
    setLine(command);
    if (!window.oracleDesktop?.runCli) return;
    setBusy(true);
    try {
      setResult(await window.oracleDesktop.runCli(command));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="min-h-full bg-[#0B1018] px-1 py-2 text-[#DDF1FF] sm:px-3 sm:py-4">
      <div className="mx-auto max-w-[1100px]">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,.72fr)_minmax(0,1.28fr)] lg:items-start">
          <aside className="border border-[var(--fable-line)] bg-[var(--fable-s0)] p-5">
            <span className="fable-eyebrow">CLI</span>
            <h1 className="fable-display mt-4 text-[2.6rem] leading-none tracking-[-.05em] sm:text-[4.4rem]">
              oracle
              <br />
              command line
            </h1>
            <p className="mt-5 max-w-[42ch] text-[0.76rem] leading-relaxed text-[var(--fable-ink-mid)]">
              The desktop ships the public Oracle CLI and runs it inside an app-owned profile. Reads and prepares stay local, keyless, and policy-bounded.
            </p>
            <div className="mt-6 grid gap-2">
              {QUICK.map((cmd) => (
                <button
                  key={cmd}
                  type="button"
                  onClick={() => void run(cmd)}
                  className="group flex items-center justify-between gap-4 border border-[var(--fable-line)] px-3 py-2.5 text-left font-mono-ui text-[0.62rem] text-[var(--fable-ink-mid)] transition-colors hover:border-[#7CC4FF]/45 hover:text-[#DDF1FF]"
                >
                  <span className="truncate">{cmd}</span>
                  <span className="text-[#7CC4FF]/60 transition-colors group-hover:text-[#7CC4FF]">run</span>
                </button>
              ))}
            </div>
          </aside>

          <div className="min-w-0 border border-[var(--fable-line-strong)] bg-[var(--fable-s1)] p-3 shadow-[0_30px_120px_rgba(0,0,0,.28)] sm:p-4">
            <div className="mb-3 flex items-center gap-2 border border-[var(--fable-line)] bg-[#070C13] px-3 py-2">
              <span className="font-mono-ui text-[0.7rem] text-[#7CC4FF]">$</span>
              <input
                value={line}
                onChange={(event) => setLine(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void run();
                }}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent font-mono-ui text-[0.76rem] text-[var(--fable-ink)] outline-none placeholder:text-[var(--fable-ink-low)]"
                placeholder="oracle --help"
              />
              <button
                type="button"
                disabled={!available || busy}
                onClick={() => void run()}
                className="border border-[#7CC4FF]/30 px-3 py-1.5 font-mono-ui text-[0.56rem] uppercase tracking-[0.16em] text-[#7CC4FF] transition-colors hover:border-[#7CC4FF] disabled:cursor-not-allowed disabled:opacity-35"
              >
                {busy ? "busy" : "run"}
              </button>
            </div>
            {!available && (
              <div className="mb-3 border border-[#F3C879]/25 bg-[#F3C879]/[0.06] px-3 py-2 font-mono-ui text-[0.62rem] uppercase tracking-[0.12em] text-[#F3C879]">
                CLI bridge appears only in the packaged desktop app.
              </div>
            )}
            <Output result={result} busy={busy} />
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[var(--fable-ink-low)]">
              <span>public package</span>
              <span>/</span>
              <span>loopback data plane</span>
              <span>/</span>
              <span>no signer access</span>
              <span>/</span>
              <span>no remote compute</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
