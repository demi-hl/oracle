"use client";

import { cn } from "@/lib/utils";
import { OracleMark } from "@/components/oracle/OracleMark";
import { ORACLE_PRODUCT } from "@/lib/oracle/brand";

export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn("flex select-none items-center gap-2.5", className)}>
      <OracleMark size={30} />
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="font-display-ui text-[1.2rem] leading-none text-ink">
          {ORACLE_PRODUCT.wordmark}
        </span>
        <span className="font-mono-ui text-[0.5rem] uppercase leading-none tracking-[0.22em] text-text-tertiary">
          multichain control plane
        </span>
      </span>
    </span>
  );
}
