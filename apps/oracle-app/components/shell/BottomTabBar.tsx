"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  PRIMARY_TABS,
  ALL_TABS,
  PRIMARY_TAB_IDS,
  HIDDEN_FROM_MORE,
  type TabDef,
  type TabId,
} from "./tabs";
import { MoreIcon } from "./icons";
import { Sheet } from "./Sheet";
import { haptic } from "./haptics";
import { cn } from "@/lib/utils";

/**
 * Bottom tab bar (mobile nav). Renders a FIXED primary set (PRIMARY_TAB_IDS)
 * plus a "More" entry that opens a sheet for the rest. Active tab uses the
 * theme's midground accent with a shared-layout sliding indicator. Frosted,
 * safe-area aware, haptic on tap. The bar is not user-customizable — to change
 * what's pinned, edit PRIMARY_TAB_IDS in tabs.tsx.
 */
export function BottomTabBar({
  activeTab,
  onSelect,
}: {
  activeTab: TabId;
  onSelect: (id: TabId) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);

  const moreTabs: TabDef[] = ALL_TABS.filter(
    (t) => !PRIMARY_TAB_IDS.includes(t.id) && !HIDDEN_FROM_MORE.includes(t.id),
  );
  const moreActive = moreTabs.some((t) => t.id === activeTab);

  const select = (id: TabId) => {
    haptic(10);
    onSelect(id);
  };

  return (
    <nav
      aria-label="Primary"
      className="border-t border-border"
      style={{
        background: "color-mix(in srgb, var(--background-base) 44%, transparent)",
        backdropFilter: "blur(22px) saturate(160%)",
        WebkitBackdropFilter: "blur(22px) saturate(160%)",
        paddingBottom: "max(6px, calc(env(safe-area-inset-bottom) - 10px))",
      }}
    >
      <ul className="flex h-[54px] items-stretch">
        {PRIMARY_TABS.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={activeTab === tab.id}
            onClick={() => select(tab.id)}
          />
        ))}

        <li className="flex-1">
          <button
            type="button"
            aria-label="More tabs"
            aria-expanded={moreOpen}
            onClick={() => {
              haptic(10);
              setMoreOpen(true);
            }}
            className={cn(
              "relative flex h-full w-full flex-col items-center justify-center gap-1 transition-colors",
              moreActive ? "text-midground" : "text-text-tertiary",
            )}
          >
            {moreActive && <ActiveIndicator />}
            <MoreIcon width={21} height={21} />
            <span className="font-mono-ui text-[0.64rem] tracking-wide">
              More
            </span>
          </button>
        </li>
      </ul>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <div className="grid grid-cols-3 gap-2 p-1.5">
          {moreTabs.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  haptic(10);
                  onSelect(tab.id);
                  setMoreOpen(false);
                }}
                className={cn(
                  "flex aspect-square flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border transition-colors",
                  active
                    ? "border-transparent bg-[color-mix(in_srgb,var(--midground)_12%,transparent)] text-midground"
                    : "border-border text-text-secondary active:bg-[color-mix(in_srgb,var(--midground)_6%,transparent)]",
                )}
              >
                <tab.Icon width={24} height={24} />
                <span className="font-mondwest text-display text-[0.66rem] tracking-wide">
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </Sheet>
    </nav>
  );
}

function TabButton({
  tab,
  active,
  onClick,
}: {
  tab: TabDef;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li className="flex-1">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={tab.label}
        onClick={onClick}
        className={cn(
          "relative flex h-full w-full flex-col items-center justify-center gap-1 transition-colors",
          active ? "text-midground" : "text-text-tertiary",
        )}
      >
        {active && <ActiveIndicator />}
        <motion.span
          animate={{ scale: active ? 1.04 : 1, y: active ? -1 : 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 30 }}
          className="relative z-[1]"
        >
          <tab.Icon width={21} height={21} />
        </motion.span>
        <span className="relative z-[1] font-mono-ui text-[0.64rem] tracking-wide">
          {tab.shortLabel}
        </span>
      </button>
    </li>
  );
}

/** Shared-layout sliding highlight + a top accent tick. */
function ActiveIndicator() {
  return (
    <>
      <motion.span
        layoutId="tab-indicator"
        transition={{ type: "spring", stiffness: 480, damping: 38 }}
        aria-hidden
        className="absolute inset-x-2 top-1.5 bottom-1.5 rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--midground)_10%,transparent)]"
      />
      <motion.span
        layoutId="tab-tick"
        transition={{ type: "spring", stiffness: 480, damping: 38 }}
        aria-hidden
        className="absolute top-0 h-[2px] w-7 rounded-full bg-midground"
        style={{ boxShadow: "0 0 10px var(--midground)" }}
      />
    </>
  );
}
