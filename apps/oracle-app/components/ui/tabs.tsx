"use client";
import { useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * Tabs / TabsList / TabsTrigger — vendored VERBATIM from @nous-research/ui@0.19.1
 * (dist/ui/components/tabs.js). `cn` import rewired to local; markup/classes
 * unchanged. Carries no `three` weight.
 */
interface TabsProps {
  children: (active: string, setActive: (value: string) => void) => ReactNode;
  className?: string;
  defaultValue: string;
}

export function Tabs({ children, className, defaultValue }: TabsProps) {
  const [active, setActive] = useState(defaultValue);
  return <div className={cn("flex flex-col gap-4", className)}>{children(active, setActive)}</div>;
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "inline-flex h-9 items-center justify-start border-b border-midground/15 text-text-secondary",
        className,
      )}
      {...props}
    />
  );
}

interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  value: string;
}

export function TabsTrigger({ active, className, value: _value, ...props }: TabsTriggerProps) {
  return (
    <button
      className={cn(
        "relative inline-flex items-center justify-center whitespace-nowrap px-3 py-1.5",
        "font-mondwest text-display text-xs tracking-[0.1em] transition-all cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-midground/30",
        active
          ? "text-midground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-midground"
          : "text-text-secondary hover:text-midground",
        className,
      )}
      type="button"
      {...props}
    />
  );
}
