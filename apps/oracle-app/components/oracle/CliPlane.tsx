"use client";

import { useState } from "react";

/**
 * The CLI plane.
 *
 * Every line below is verbatim `oracle --help` output from the version this app
 * ships alongside, not an illustrative mockup. If the help text changes, the
 * snapshot test in test/cli-plane.test.mjs fails, because a marketing surface
 * that drifts from the tool it advertises is the same defect class this app was
 * just audited for.
 */

const INSTALL = "npm i -g @oracle-agent/oracle";

/** Verbatim from `oracle --help`. Keep in sync or the test fails. */
const HELP_LINES: [string, string][] = [
  ["oracle", "open the native Oracle chat (TTY)"],
  ["oracle init", "install agent lanes + read plane (dry-run by default)"],
  ["oracle doctor", "check read plane; checks signer too when installed"],
  ["oracle chain", "list/select working chains (hyperliquid, base, ...)"],
  ["oracle data serve|call|catalog|health", ""],
  ["oracle scan chains|head|token|pools|risk|quote|sell", ""],
  ["oracle route swap|bridge|prepare|prepare-bridge", ""],
  ["oracle prepare", "build an unsigned swap (alias of route prepare)"],
  ["oracle mcp install <t>", "wire Oracle into claude-code|claude-desktop|codex|chatgpt"],
];

/** Verbatim from `oracle --help`, SIGNING section. */
const SIGNING_LINES: [string, string][] = [
  ["oracle sign init|doctor", "provision / check the local signer (opt-in)"],
  ["oracle signer / runner", "loopback signer daemon / action runner"],
  ["oracle credential ...", "OS credential store glue"],
];

export function CliPlane() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section aria-label="CLI plane" className="mt-14 lg:mt-20">
      <span className="fable-eyebrow">Command line</span>

      <div className="mt-4 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center lg:gap-12">
        <div>
          <h2 className="fable-display text-[1.5rem] leading-tight lg:text-[1.9rem]">
            The same plane, without the browser
          </h2>
          <p className="mt-3 max-w-[52ch] text-[0.74rem] leading-relaxed text-[var(--fable-ink-mid)]">
            This surface is one client. The CLI is the other, and it is the one that can hold
            keys, because it runs on your machine instead of ours. Reads and prepares behave
            identically in both; only the local install can reach a signer.
          </p>

          <button
            type="button"
            onClick={copy}
            className="group mt-6 flex w-full items-center gap-3 border border-[var(--fable-line-strong)] px-4 py-3 text-left transition-colors duration-300 hover:border-[#7CC4FF]/45 sm:w-auto"
            style={{ background: "var(--fable-s1)" }}
          >
            <span aria-hidden className="font-mono-ui text-[0.68rem] text-[#7CC4FF]/70">$</span>
            <code className="min-w-0 flex-1 truncate font-mono-ui text-[0.72rem] text-[var(--fable-ink-hi)]">
              {INSTALL}
            </code>
            <span className="shrink-0 font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[var(--fable-ink-low)] transition-colors group-hover:text-[#7CC4FF]">
              {copied ? "copied" : "copy"}
            </span>
          </button>

          <p className="mt-3 text-[0.66rem] leading-relaxed text-[var(--fable-ink-low)]">
            Requires Node 20+. Signing commands dispatch to a separately installed operator
            package; this one cannot sign.
          </p>
        </div>

        <div
          className="min-w-0 overflow-hidden border border-[var(--fable-line)]"
          style={{ background: "var(--fable-s0)" }}
        >
          <div
            className="flex items-center gap-2 border-b border-[var(--fable-line)] px-4 py-2.5"
            style={{ background: "var(--fable-s1)" }}
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#7CC4FF]/40" />
            <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[var(--fable-ink-low)]">
              oracle --help
            </span>
          </div>

          <div className="px-4 py-4 sm:overflow-x-auto">
            {/* At 390px the help clipped mid-description behind a horizontal
                scrollbar, which hides content with no affordance on a phone.
                Wrap on small screens; keep exact console formatting from sm up. */}
            <pre className="min-w-0 whitespace-pre-wrap break-words font-mono-ui text-[0.58rem] leading-[1.75] text-[var(--fable-ink)] sm:whitespace-pre sm:break-normal sm:text-[0.66rem]">
              <span className="text-[var(--fable-ink-low)]">READ / RESEARCH (no keys, this package)</span>
              {"\n"}
              {HELP_LINES.map(([cmd, detail]) => (
                <span key={cmd}>
                  {"  "}
                  <span className="text-[#7CC4FF]">{cmd}</span>
                  {detail ? (
                    <>
                      {"\n      "}
                      <span className="text-[var(--fable-ink-mid)]">{detail}</span>
                    </>
                  ) : null}
                  {"\n"}
                </span>
              ))}
              {"\n"}
              <span className="text-[var(--fable-ink-low)]">SIGNING (runs on THIS machine, never in this package)</span>
              {"\n"}
              {SIGNING_LINES.map(([cmd, detail]) => (
                <span key={cmd}>
                  {"  "}
                  <span className="text-[#7CC4FF]">{cmd}</span>
                  {"\n      "}
                  <span className="text-[var(--fable-ink-mid)]">{detail}</span>
                  {"\n"}
                </span>
              ))}
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
