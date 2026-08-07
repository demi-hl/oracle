"use client";

import { useState } from "react";
import Image from "next/image";
import { ThemeSheet } from "./ThemeSwitcher";
import { PaletteIcon } from "./icons";
import { haptic } from "./haptics";
import { ALL_TABS, type TabId } from "./tabs";
import { cn } from "@/lib/utils";

export function AppHeader({
  activeTab,
  onSelect,
}: {
  activeTab: TabId;
  onSelect: (id: TabId) => void;
}) {
  const [themeOpen, setThemeOpen] = useState(false);

  return (
    <header
      className="absolute inset-x-0 top-0 z-30 flex items-center gap-4 border-b border-[color-mix(in_srgb,var(--midground)_12%,transparent)] px-3 backdrop-blur-2xl sm:px-6"
      style={{
        height: "calc(var(--app-header-h) + env(safe-area-inset-top))",
        paddingTop: "env(safe-area-inset-top)",
        background: "color-mix(in srgb, var(--background-base) 72%, transparent)",
      }}
    >
      <button
        type="button"
        onClick={() => {
          void haptic(6);
          onSelect("tasks");
        }}
        className="flex shrink-0 items-center gap-2.5"
        aria-label="Oracle home"
      >
        <Image src="/oracle-mark.svg" alt="" width={26} height={26} priority className="h-[26px] w-auto" />
        <span className="font-display-ui text-[1.15rem] font-light leading-none tracking-[-0.04em] text-ink">
          Oracle
        </span>
      </button>

      <nav className="hidden min-w-0 flex-1 items-center gap-1 lg:flex" aria-label="Oracle">
        {ALL_TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelect(tab.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative px-3 py-2 text-[13px] transition-colors",
                active ? "text-ink" : "text-text-tertiary hover:text-ink",
              )}
            >
              {tab.label}
              {active && (
                <span className="absolute inset-x-2 -bottom-px h-px bg-midground shadow-[0_0_10px_var(--midground)]" />
              )}
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span className="hidden items-center gap-2 border border-[color-mix(in_srgb,var(--midground)_16%,transparent)] px-2.5 py-1 font-mono-ui text-[0.5rem] uppercase tracking-[0.15em] text-midground sm:inline-flex">
          <span className="h-1 w-1 rounded-full bg-midground shadow-[0_0_8px_var(--midground)]" aria-hidden />
          keyless, prepare-only
        </span>
        <button
          type="button"
          aria-label="Switch theme"
          onClick={() => {
            haptic(8);
            setThemeOpen(true);
          }}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border text-text-secondary transition-colors hover:text-midground"
        >
          <PaletteIcon width={17} height={17} />
        </button>
      </div>

      <ThemeSheet open={themeOpen} onClose={() => setThemeOpen(false)} />
    </header>
  );
}
