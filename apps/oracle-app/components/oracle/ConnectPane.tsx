"use client";

import { useMemo, useState } from "react";

const PACKAGE_NAME = "@oracle-agent/oracle";
const MCP_COMMAND = "npx";
const MCP_ARGS = ["-y", "--package", PACKAGE_NAME, "oracle-data-mcp"];
const INIT_COMMAND = "npx -y --package @oracle-agent/oracle oracle-init";
const ORACLE_BLUE = "#7CC4FF";
const ORACLE_INK = "#F4F9FE";
const ORACLE_MUTE = "#9FB8D2";
const HAIRLINE = "rgba(124,196,255,.14)";

type Harness = "hermes" | "claude" | "codex" | "cursor" | "mcp";

type EnvMap = Record<string, string>;

const HARNESSES: { id: Harness; label: string; detail: string }[] = [
  { id: "hermes", label: "Hermes", detail: "config.yaml mcp_servers block" },
  { id: "claude", label: "Claude Code", detail: ".mcp.json payload" },
  { id: "codex", label: "Codex", detail: "TOML mcp server block" },
  { id: "cursor", label: "Cursor", detail: "MCP JSON server" },
  { id: "mcp", label: "Generic MCP", detail: "portable JSON" },
];

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function envMap(url: string, key: string, wallet: string): EnvMap {
  const values: EnvMap = {
    ORACLE_DATA_URL: url.trim().replace(/\/+$/, "") || "http://127.0.0.1:8799",
    ORACLE_AGENT_KEY: key.trim() || "YOUR_READ_KEY",
  };
  if (wallet.trim()) values.ORACLE_WALLET_ADDRESS = wallet.trim();
  return values;
}

function server(values: EnvMap) {
  return { command: MCP_COMMAND, args: MCP_ARGS, env: values };
}

function renderConfig(harness: Harness, values: EnvMap): string {
  if (harness === "hermes") {
    return [
      "mcp_servers:",
      "  oracle:",
      `    command: ${json(MCP_COMMAND)}`,
      "    args:",
      ...MCP_ARGS.map((arg) => `      - ${json(arg)}`),
      "    env:",
      ...Object.entries(values).map(([key, value]) => `      ${key}: ${json(value)}`),
      "",
    ].join("\n");
  }
  if (harness === "codex") {
    return [
      "[mcp_servers.oracle]",
      `command = ${json(MCP_COMMAND)}`,
      `args = [${MCP_ARGS.map(json).join(", ")}]`,
      "",
      "[mcp_servers.oracle.env]",
      ...Object.entries(values).map(([key, value]) => `${key} = ${json(value)}`),
      "",
    ].join("\n");
  }
  return json({ mcpServers: { oracle: server(values) } });
}

async function copy(text: string, setStatus: (value: string) => void) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus("copied");
  } catch {
    setStatus("copy blocked, select text manually");
  }
}

export function ConnectPane() {
  const [url, setUrl] = useState("http://127.0.0.1:8799");
  const [key, setKey] = useState("");
  const [wallet, setWallet] = useState("");
  const [harness, setHarness] = useState<Harness>("hermes");
  const [status, setStatus] = useState("");
  const values = useMemo(() => envMap(url, key, wallet), [url, key, wallet]);
  const config = useMemo(() => renderConfig(harness, values), [harness, values]);
  const active = HARNESSES.find((item) => item.id === harness) ?? HARNESSES[0];

  return (
    <section className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 overflow-y-auto p-4 text-[#DDF1FF] sm:p-6">
      <header className="grid gap-4 border-b border-[#7CC4FF]/10 pb-5 lg:grid-cols-[1fr_auto]">
        <div>
          <p className="font-mono-ui text-[0.56rem] uppercase tracking-[0.2em] text-[#7CC4FF]/58">Agent Connect</p>
          <h1 className="mt-2 font-display-ui text-[2.2rem] leading-none tracking-[-0.05em] text-[#EEF8FF] sm:text-[3rem]">
            connect the brain, keep custody local
          </h1>
          <p className="mt-3 max-w-2xl text-[0.78rem] leading-relaxed text-[#DDF1FF]/56">
            Build read MCP configs for Hermes, Claude Code, Codex, Cursor, and any MCP client. This page does not connect a wallet, request a signature, or persist the read key.
          </p>
        </div>
        <div className="grid min-w-[240px] gap-px overflow-hidden border border-[#7CC4FF]/12 bg-[#7CC4FF]/10 sm:grid-cols-3 lg:grid-cols-1">
          {[
            ["mode", "read MCP"],
            ["wallet", "optional"],
            ["execution", "user wallet"],
          ].map(([label, value]) => (
            <div key={label} className="bg-[#0B1018] p-3">
              <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.16em] text-[#7CC4FF]/42">{label}</div>
              <div className="mt-1 font-mono-ui text-[0.66rem] uppercase tracking-[0.14em] text-[#DDF1FF]">{value}</div>
            </div>
          ))}
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[390px_1fr]">
        <section className="border border-[#7CC4FF]/12 bg-[#0B1018]/82 p-4" aria-labelledby="connect-inputs-heading">
          <p id="connect-inputs-heading" className="font-mono-ui text-[0.56rem] uppercase tracking-[0.18em] text-[#7CC4FF]/50">Connection</p>
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1.5">
              <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Agent API URL</span>
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 border border-[#7CC4FF]/16 bg-[#080D13] px-3 font-mono-ui text-[0.72rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50"
              />
            </label>
            <label className="grid gap-1.5">
              <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Read API key</span>
              <input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                type="password"
                placeholder="YOUR_READ_KEY"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 border border-[#7CC4FF]/16 bg-[#080D13] px-3 font-mono-ui text-[0.72rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50"
              />
              <span className="text-[0.66rem] text-[#DDF1FF]/42">Use a read credential only. Never paste signing material here.</span>
            </label>
            <label className="grid gap-1.5">
              <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Public wallet address</span>
              <input
                value={wallet}
                onChange={(event) => setWallet(event.target.value)}
                placeholder="optional"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="h-11 border border-[#7CC4FF]/16 bg-[#080D13] px-3 font-mono-ui text-[0.72rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50"
              />
            </label>
          </div>
        </section>

        <section className="overflow-hidden border border-[#7CC4FF]/12 bg-[#0B1018]/82" aria-labelledby="connect-config-heading">
          <div className="border-b border-[#7CC4FF]/10 p-4">
            <p id="connect-config-heading" className="font-mono-ui text-[0.56rem] uppercase tracking-[0.18em] text-[#7CC4FF]/50">Harness config</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {HARNESSES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setHarness(item.id);
                    setStatus("");
                  }}
                  className="rounded-full border px-3 py-1.5 font-mono-ui text-[0.56rem] uppercase tracking-[0.12em] transition-colors"
                  style={{
                    borderColor: item.id === harness ? ORACLE_BLUE : HAIRLINE,
                    color: item.id === harness ? ORACLE_BLUE : ORACLE_MUTE,
                    background: item.id === harness ? "rgba(124,196,255,.08)" : "transparent",
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-b border-[#7CC4FF]/10 px-4 py-3">
            <div>
              <div className="text-[0.8rem] text-[#EEF8FF]">{active.label}</div>
              <div className="mt-0.5 font-mono-ui text-[0.5rem] uppercase tracking-[0.12em] text-[#7CC4FF]/38">{active.detail}</div>
            </div>
            <button
              type="button"
              onClick={() => copy(config, setStatus)}
              className="border border-[#7CC4FF]/22 px-3 py-2 font-mono-ui text-[0.55rem] uppercase tracking-[0.12em] text-[#7CC4FF]"
            >
              Copy
            </button>
          </div>
          <pre className="max-h-[420px] overflow-auto p-4 text-[0.68rem] leading-relaxed text-[#DDF1FF]/78"><code>{config}</code></pre>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#7CC4FF]/10 px-4 py-3">
            <button
              type="button"
              onClick={() => copy(INIT_COMMAND, setStatus)}
              className="border border-[#7CC4FF]/16 px-3 py-2 font-mono-ui text-[0.55rem] uppercase tracking-[0.12em] text-[#9FB8D2]"
            >
              Copy optional profile init
            </button>
            <span className="font-mono-ui text-[0.52rem] uppercase tracking-[0.14em] text-[#7CC4FF]/48">{status || "ready"}</span>
          </div>
        </section>
      </div>

      <section className="grid gap-px overflow-hidden border border-[#7CC4FF]/10 bg-[#7CC4FF]/10 sm:grid-cols-3">
        {[
          ["01", "Agent reads", "portfolio, routes, status, catalog"],
          ["02", "Agent proposes", "quotes, prepares, explains risk"],
          ["03", "User authorizes", "their wallet reviews the exact action"],
        ].map(([step, label, detail]) => (
          <article key={step} className="bg-[#0B1018] p-4">
            <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.16em] text-[#7CC4FF]/42">{step}</div>
            <h2 className="mt-3 text-[0.88rem] text-[#EEF8FF]">{label}</h2>
            <p className="mt-1.5 text-[0.68rem] leading-relaxed text-[#DDF1FF]/46">{detail}</p>
          </article>
        ))}
      </section>
    </section>
  );
}

export default ConnectPane;
