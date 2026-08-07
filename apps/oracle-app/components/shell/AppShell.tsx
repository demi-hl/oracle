"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { AppHeader } from "./AppHeader";
import { BottomTabBar } from "./BottomTabBar";
import { WalletRail } from "./WalletRail";
import { Splash } from "./Splash";
import { getTab, ALL_TABS, DEFAULT_TAB_ID, type TabId } from "./tabs";
import { haptic } from "./haptics";
import { cn } from "@/lib/utils";

const SHELL_VARS = {
  "--app-header-h": "58px",
  "--app-context-h": "0px",
  "--app-tabbar-h": "54px",
} as CSSProperties;

export function AppShell({ initialTab = DEFAULT_TAB_ID }: { initialTab?: TabId }) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ActivePane = getTab(activeTab)?.Pane ?? getTab(DEFAULT_TAB_ID).Pane;

  const goTab = useCallback((id: TabId) => {
    haptic(8);
    setActiveTab(id);
    window.dispatchEvent(new CustomEvent("oracle-tab", { detail: { id } }));
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const idx = event.key === "0" ? 9 : Number(event.key) - 1;
      if (!Number.isInteger(idx) || idx < 0) return;
      const tab = ALL_TABS[idx];
      if (!tab) return;
      event.preventDefault();
      goTab(tab.id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goTab]);

  useEffect(() => {
    const handler = (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: TabId }>).detail?.tab;
      if (tab && getTab(tab)) goTab(tab);
    };
    window.addEventListener("lo-nav", handler as EventListener);
    return () => window.removeEventListener("lo-nav", handler as EventListener);
  }, [goTab]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [activeTab]);

  return (
    <div className="relative flex h-[var(--app-vh,100dvh)] w-full flex-col overflow-hidden text-ink" style={SHELL_VARS}>
      <Splash />
      <AppHeader activeTab={activeTab} onSelect={goTab} />
      <div className="relative z-10 flex min-h-0 flex-1">
      <main
        ref={scrollRef}
        className={cn(
          "relative z-10 min-w-0 flex-1 overflow-y-auto overscroll-contain",
          "px-3 pb-[calc(var(--app-tabbar-h)+env(safe-area-inset-bottom)+16px)] sm:px-6 lg:px-8 lg:pb-10",
          "pt-[calc(var(--app-header-h)+env(safe-area-inset-top)+18px)]",
        )}
      >
        <div className="mx-auto w-full max-w-[1180px]">
          <ActivePane />
        </div>
      </main>
      <WalletRail />
      </div>
      <div className="relative z-30 lg:hidden">
        <BottomTabBar activeTab={activeTab} onSelect={goTab} />
      </div>
    </div>
  );
}
