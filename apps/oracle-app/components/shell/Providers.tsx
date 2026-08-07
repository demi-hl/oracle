"use client";

import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { ThemeProvider } from "@/lib/themes";

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = document.documentElement;
    const body = document.body;

    const pinToViewport = () => {
      const vh = window.visualViewport?.height ?? window.innerHeight;
      root.style.setProperty("--app-vh", `${vh}px`);
      root.style.height = `${vh}px`;
      body.style.minHeight = `${vh}px`;
    };

    pinToViewport();
    window.visualViewport?.addEventListener("resize", pinToViewport);
    window.addEventListener("resize", pinToViewport);
    return () => {
      window.visualViewport?.removeEventListener("resize", pinToViewport);
      window.removeEventListener("resize", pinToViewport);
    };
  }, []);

  return (
    <ThemeProvider>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </ThemeProvider>
  );
}
