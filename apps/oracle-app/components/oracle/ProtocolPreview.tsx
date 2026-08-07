"use client";

import { useMemo, useState } from "react";
import { haptic } from "@/components/shell/haptics";

const ORACLE_BLUE = "#7CC4FF";
const HAIRLINE = "rgba(124,196,255,.16)";

export interface PreviewCandidate {
  label: string;
  url: string;
}

function safeUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function ProtocolPreview({ candidates = [] }: { candidates?: PreviewCandidate[] }) {
  const usable = useMemo(
    () => candidates.filter((candidate) => safeUrl(candidate.url) !== null),
    [candidates],
  );
  const [raw, setRaw] = useState(usable[0]?.url ?? "");
  const [active, setActive] = useState<string | null>(usable[0]?.url ?? null);
  const [loaded, setLoaded] = useState(false);

  const parsed = active === null ? null : safeUrl(active);
  const draft = safeUrl(raw);

  const load = (url: string) => {
    if (safeUrl(url) === null) return;
    void haptic(6);
    setLoaded(false);
    setRaw(url);
    setActive(url);
  };

  return (
    <section className="mt-3 border" style={{ borderColor: HAIRLINE, background: "rgba(11,16,24,.55)" }} aria-labelledby="protocol-preview-heading">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5" style={{ borderColor: "rgba(124,196,255,.12)" }}>
        <h3 id="protocol-preview-heading" className="font-mono-ui text-[0.5rem] uppercase tracking-[0.18em]" style={{ color: ORACLE_BLUE }}>
          Protocol preview
        </h3>
        <span className="font-mono-ui text-[0.48rem] uppercase tracking-[0.12em] text-[#9FB8D2]/60">
          sandboxed, display only
        </span>
      </div>

      <div className="px-4 py-4">
        {usable.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {usable.map((candidate) => (
              <button
                key={candidate.url}
                type="button"
                onClick={() => load(candidate.url)}
                className="border px-2.5 py-1.5 font-mono-ui text-[0.52rem] uppercase tracking-[0.12em] transition-colors"
                style={{
                  borderColor: active === candidate.url ? ORACLE_BLUE : HAIRLINE,
                  color: active === candidate.url ? ORACLE_BLUE : "#9FB8D2",
                }}
              >
                {candidate.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="protocol-preview-url" className="sr-only">
            Protocol URL to preview
          </label>
          <input
            id="protocol-preview-url"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") load(raw);
            }}
            placeholder="https://your-protocol.xyz"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 border bg-transparent px-3 py-2 font-mono-ui text-[0.75rem] outline-none placeholder:text-[#9FB8D2]/40"
            style={{ borderColor: HAIRLINE, color: "#F4F9FE" }}
          />
          <button
            type="button"
            onClick={() => load(raw)}
            disabled={draft === null}
            className="shrink-0 border px-4 py-2 font-mono-ui text-[0.58rem] uppercase tracking-[0.14em] disabled:opacity-35"
            style={{ borderColor: ORACLE_BLUE, color: ORACLE_BLUE }}
          >
            Preview
          </button>
        </div>

        {raw.trim() !== "" && draft === null && (
          <p role="status" className="mt-2 font-mono-ui text-[0.6rem] text-[#FF6357]">
            Preview requires an https URL.
          </p>
        )}

        {parsed !== null && (
          <div className="mt-4">
            <div className="flex items-center justify-between gap-3 border border-b-0 px-3 py-2" style={{ borderColor: HAIRLINE }}>
              <span className="truncate font-mono-ui text-[0.6rem] text-[#9FB8D2]">{parsed.origin}</span>
              <a
                href={parsed.toString()}
                target="_blank"
                rel="noreferrer noopener"
                className="shrink-0 font-mono-ui text-[0.52rem] uppercase tracking-[0.12em]"
                style={{ color: ORACLE_BLUE }}
              >
                Open
              </a>
            </div>
            <iframe
              key={parsed.toString()}
              src={parsed.toString()}
              title={`Protocol preview for ${parsed.origin}`}
              onLoad={() => setLoaded(true)}
              sandbox="allow-scripts allow-popups allow-forms"
              referrerPolicy="no-referrer"
              loading="lazy"
              className="block h-[420px] w-full border bg-[#06101B]"
              style={{ borderColor: HAIRLINE }}
            />
            {!loaded && (
              <p className="mt-2 font-mono-ui text-[0.58rem] uppercase tracking-[0.1em] text-[#9FB8D2]/55">
                Loading frame. Some hosts block embedding and will stay blank.
              </p>
            )}
          </div>
        )}

        <p className="mt-4 text-[0.7rem] leading-relaxed text-[#9FB8D2]/60">
          The frame runs without same-origin access to this app. Previewing a protocol never
          connects a wallet, signs, or broadcasts.
        </p>
      </div>
    </section>
  );
}

export default ProtocolPreview;
