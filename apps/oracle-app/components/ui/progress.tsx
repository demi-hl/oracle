"use client";
import type { ComponentProps } from "react";
import { Typography, type TypographyProps } from "./typography";
import { cn } from "./cn";

/**
 * Progress — vendored VERBATIM from @nous-research/ui@0.19.1
 * (dist/ui/components/progress.js). `cn`/`Typography` imports rewired to local;
 * markup/classes/inline-style unchanged. Carries no `three` weight.
 */
interface ProgressProps extends ComponentProps<"div"> {
  animate?: boolean;
  barProps?: TypographyProps<"span">;
  speed?: number;
  value: number;
}

export const Progress = ({
  animate = true,
  barProps,
  children,
  className,
  speed = 0.4,
  value,
  ...props
}: ProgressProps) => (
  <div
    className={cn(
      "relative flex min-h-[2.3rem] min-w-0 flex-1 items-stretch overflow-hidden",
      className,
    )}
    {...props}
  >
    <Typography
      {...barProps}
      className={cn(
        "shrink-0 translate-y-0.5 truncate py-2",
        "bg-midground/20",
        children ? "px-2" : "px-0",
        barProps?.className,
      )}
      mono
      style={{
        ...(animate && { transition: `width ${speed}s steps(10, end)` }),
        width: `${value}%`,
        ...barProps?.style,
      }}
    >
      {children}
    </Typography>
    <div
      className="flex-1"
      style={
        {
          "--x": ".5rem",
          backgroundImage:
            "repeating-linear-gradient(to right, transparent 0 var(--x), color-mix(in srgb, var(--color-midground) 17%, transparent) var(--x) calc(var(--x) + 1px))",
        } as React.CSSProperties
      }
    />
  </div>
);
