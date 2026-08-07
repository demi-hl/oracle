"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Collapsible wallet rail.
 *
 * Entry-first by necessity, not preference. A cold wallet cannot be connected
 * (that is what cold means), and BTC/SOL wallets do not speak the EVM connector
 * protocol at all, so a book that can only be filled by "connect" could never
 * hold the wallets DEMI actually operates. Typed entry works for every case;
 * connect is one optional autofill button for whichever EVM wallet happens to
 * be in this browser.
 *
 * Nothing here touches key material. eth_requestAccounts returns a public
 * address. Reads never require a connection.
 */

const ORACLE_BLUE = "#7CC4FF";
const ORACLE_INK = "#F4F9FE";
const ORACLE_MUTE = "#9FB8D2";
const HAIRLINE = "rgba(124,196,255,.14)";

const BOOK_KEY = "oracle-wallet-book";
const COLLAPSE_KEY = "oracle-wallet-rail-collapsed";
// The single-address key every existing pane already reads. The book stays
// authoritative and mirrors the active EVM entry here, so Portfolio, Approvals,
// NFTs and Swap keep working untouched.
const LEGACY_EVM_KEY = "oracle-portfolio-evm";

export type WalletFamily = "evm" | "solana" | "bitcoin";

export interface WalletEntry {
  id: string;
  address: string;
  family: WalletFamily;
  label: string;
  name?: string | null;
  nameSource?: string | null;
}

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BTC_RE = /^([13][1-9A-HJ-NP-Za-km-z]{25,34}|bc1[ac-hj-np-z02-9]{11,71})$/i;

export function familyOf(address: string): WalletFamily | null {
  const v = address.trim();
  if (EVM_RE.test(v)) return "evm";
  if (BTC_RE.test(v)) return "bitcoin";
  if (SOL_RE.test(v)) return "solana";
  return null;
}

const FAMILY_LABEL: Record<WalletFamily, string> = {
  evm: "EVM",
  solana: "SOL",
  bitcoin: "BTC",
};

function readBook(): WalletEntry[] {
  try {
    const raw = window.localStorage.getItem(BOOK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e.address === "string" && familyOf(e.address));
  } catch {
    return [];
  }
}

function writeBook(entries: WalletEntry[]) {
  try {
    window.localStorage.setItem(BOOK_KEY, JSON.stringify(entries));
    const activeEvm = entries.find((e) => e.family === "evm");
    if (activeEvm) window.localStorage.setItem(LEGACY_EVM_KEY, activeEvm.address);
    window.dispatchEvent(new CustomEvent("oracle-wallet-book", { detail: { entries } }));
  } catch {
    /* private mode: the book is a convenience, not a requirement */
  }
}

function shorten(address: string) {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function WalletRail() {
  const [collapsed, setCollapsed] = useState(true);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEntries(readBook());
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) !== "0");
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const commit = useCallback((next: WalletEntry[]) => {
    setEntries(next);
    writeBook(next);
  }, []);

  const add = useCallback(
    async (rawInput: string) => {
      const raw = rawInput.trim();
      if (!raw) return;
      setBusy(true);
      setError(null);
      try {
        let address = raw;
        let name: string | null = null;
        let nameSource: string | null = null;

        // A name is resolved to an address; an address is reverse-resolved to a
        // name. Either way the book stores the address and displays the name.
        const res = await fetch(`/api/oracle/resolve?q=${encodeURIComponent(raw)}`, { cache: "no-store" });
        if (res.ok) {
          const json = (await res.json()) as {
            address: string | null;
            name: string | null;
            source: string | null;
          };
          if (json.address) address = json.address;
          name = json.name;
          nameSource = json.source;
        }

        const family = familyOf(address);
        if (!family) {
          setError(EVM_RE.test(raw) ? "unsupported address" : "not a valid address or name");
          return;
        }
        if (entries.some((e) => e.address.toLowerCase() === address.toLowerCase())) {
          setError("already in the book");
          return;
        }

        commit([
          ...entries,
          {
            id: `${family}-${address.slice(0, 10)}-${Date.now()}`,
            address,
            family,
            label: name || `${FAMILY_LABEL[family]} wallet`,
            name,
            nameSource,
          },
        ]);
        setDraft("");
      } catch {
        setError("could not add that wallet");
      } finally {
        setBusy(false);
      }
    },
    [commit, entries],
  );

  const connect = useCallback(async () => {
    const eth = (window as unknown as { ethereum?: { request(a: { method: string }): Promise<string[]> } }).ethereum;
    if (!eth) {
      setError("no browser wallet detected");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Public address only. The key stays in the extension.
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      const account = Array.isArray(accounts) ? accounts[0] : null;
      if (account) await add(account);
    } catch {
      setError("connection rejected");
    } finally {
      setBusy(false);
    }
  }, [add]);

  const remove = useCallback(
    (id: string) => commit(entries.filter((e) => e.id !== id)),
    [commit, entries],
  );

  // The active wallet per family is the first of that family, so promoting is
  // just a reorder. One concept instead of a separate "active" flag to keep in
  // sync with deletions.
  const promote = useCallback(
    (id: string) => {
      const target = entries.find((e) => e.id === id);
      if (!target) return;
      commit([target, ...entries.filter((e) => e.id !== id)]);
    },
    [commit, entries],
  );

  const grouped = useMemo(() => {
    const out: Record<WalletFamily, WalletEntry[]> = { evm: [], solana: [], bitcoin: [] };
    for (const e of entries) out[e.family].push(e);
    return out;
  }, [entries]);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label="Open wallets"
        className="fixed right-0 top-1/2 z-20 hidden -translate-y-1/2 rounded-l-md border border-r-0 px-2 py-4 lg:block"
        style={{ borderColor: HAIRLINE, background: "rgba(17,25,37,.92)", color: ORACLE_BLUE }}
      >
        <span className="font-mono-ui text-[0.6rem] tracking-[0.2em]" style={{ writingMode: "vertical-rl" }}>
          WALLETS {entries.length > 0 ? `· ${entries.length}` : ""}
        </span>
      </button>
    );
  }

  return (
    <aside
      className="relative z-20 hidden w-[300px] shrink-0 overflow-y-auto border-l lg:block"
      style={{ borderColor: HAIRLINE, background: "rgba(17,25,37,.55)" }}
      aria-label="Wallets"
    >
      <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: HAIRLINE }}>
        <span className="font-mono-ui text-[0.6rem] tracking-[0.2em]" style={{ color: ORACLE_BLUE }}>
          WALLETS
        </span>
        <button
          type="button"
          onClick={toggle}
          aria-label="Collapse wallets"
          className="font-mono-ui text-[0.7rem]"
          style={{ color: ORACLE_MUTE }}
        >
          ›
        </button>
      </div>

      <div className="px-4 py-3">
        <label htmlFor="wallet-add" className="sr-only">
          Add a wallet address or name
        </label>
        <input
          id="wallet-add"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add(draft);
          }}
          placeholder="demi.hl, vitalik.eth, 0x…, bc1…"
          spellCheck={false}
          className="w-full rounded-md border bg-transparent px-2.5 py-2 font-mono-ui text-[0.66rem] outline-none"
          style={{ borderColor: HAIRLINE, color: ORACLE_INK }}
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => void add(draft)}
            disabled={busy || !draft.trim()}
            className="flex-1 rounded-md border px-2 py-1.5 font-mono-ui text-[0.6rem] tracking-[0.14em] disabled:opacity-40"
            style={{ borderColor: HAIRLINE, color: ORACLE_BLUE }}
          >
            {busy ? "…" : "ADD"}
          </button>
          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy}
            className="flex-1 rounded-md border px-2 py-1.5 font-mono-ui text-[0.6rem] tracking-[0.14em] disabled:opacity-40"
            style={{ borderColor: HAIRLINE, color: ORACLE_MUTE }}
          >
            CONNECT
          </button>
        </div>
        {error !== null && (
          <p role="status" className="mt-2 font-mono-ui text-[0.58rem]" style={{ color: "#FFB4A2" }}>
            {error}
          </p>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="px-4 pb-4 font-mono-ui text-[0.58rem] leading-relaxed" style={{ color: ORACLE_MUTE }}>
          Add any address to read balances, approvals and NFTs. No connection needed. Oracle reads public
          data and never holds a key.
        </p>
      ) : (
        <div className="pb-6">
          {(["evm", "solana", "bitcoin"] as WalletFamily[]).map((family) =>
            grouped[family].length === 0 ? null : (
              <section key={family} className="px-4 pt-3">
                <p className="font-mono-ui text-[0.55rem] tracking-[0.2em]" style={{ color: ORACLE_MUTE }}>
                  {FAMILY_LABEL[family]}
                </p>
                <ul className="mt-1.5 space-y-1.5">
                  {grouped[family].map((entry, index) => (
                    <li
                      key={entry.id}
                      className="rounded-md border px-2.5 py-2"
                      style={{
                        borderColor: index === 0 ? "rgba(124,196,255,.4)" : HAIRLINE,
                        background: index === 0 ? "rgba(124,196,255,.06)" : "transparent",
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => promote(entry.id)}
                          className="min-w-0 flex-1 text-left"
                          title={entry.address}
                        >
                          <span className="block truncate font-mono-ui text-[0.64rem]" style={{ color: ORACLE_INK }}>
                            {entry.name || shorten(entry.address)}
                          </span>
                          <span className="block truncate font-mono-ui text-[0.55rem]" style={{ color: ORACLE_MUTE }}>
                            {entry.name ? shorten(entry.address) : entry.label}
                            {index === 0 ? " · active" : ""}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(entry.id)}
                          aria-label={`Remove ${entry.address}`}
                          className="font-mono-ui text-[0.7rem]"
                          style={{ color: ORACLE_MUTE }}
                        >
                          ×
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ),
          )}
        </div>
      )}
    </aside>
  );
}
