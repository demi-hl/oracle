"use client";

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Badge — the Nous design-system badge. Class strings are taken VERBATIM from
 * `@nous-research/ui/ui/components/badge` (font-compressed text-display, the
 * tone palette, the 0.2em tracking). We reimplement the default tone with the
 * plain midground treatment instead of the package's BlendMode component,
 * because BlendMode statically pulls gsap + leva + three (a 3D control rig) —
 * dead weight for a static badge. Semantic tones are byte-identical to upstream.
 */
type Tone = "default" | "destructive" | "outline" | "secondary" | "success" | "warning";

const BASE_CN =
  "inline-flex items-center font-compressed text-display px-2 py-1 leading-none tracking-[0.2em]";

const TONE_CLASSES: Record<Tone, string> = {
  default:
    "border border-midground/10 bg-[color-mix(in_srgb,var(--midground)_7.5%,transparent)] text-midground",
  destructive: "border border-destructive/30 bg-destructive/15 text-destructive",
  outline: "border border-midground/30 bg-transparent text-midground/80",
  secondary: "border border-midground/15 bg-midground/8 text-midground",
  success: "border border-success/30 bg-success/15 text-success",
  warning: "border border-warning/30 bg-warning/15 text-warning",
};

interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "color"> {
  tone?: Tone;
}

export function Badge({ className, tone = "default", style, ...props }: BadgeProps) {
  const toneStyle =
    tone === "default" ? { opacity: "var(--midground-alpha)", ...style } : style;
  return (
    <span
      className={cn(BASE_CN, TONE_CLASSES[tone], className)}
      style={toneStyle}
      {...props}
    />
  );
}
