"use client";

import {
  useEffect,
  useRef,
  type ReactNode,
  type SVGProps,
} from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/* ===========================================================================
   Small, self-contained UI atoms shared by the Tasks & PRs + Automations panes.
   No new globals.css (slice 1 owns it), polish comes from Framer + DS tokens.
   =========================================================================== */

type P = SVGProps<SVGSVGElement>;
function svg(props: P) {
  return {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export const RefreshIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
  </svg>
);
export const IssueIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4M12 16h.01" />
  </svg>
);
export const ClockIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const BoltIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
  </svg>
);
export const SendPlaneIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
  </svg>
);
export const ScriptIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M9 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-5-5H9Z" />
    <path d="M8 13h8M8 17h5" />
  </svg>
);
export const ExternalIcon = (p: P) => (
  <svg {...svg(p)}>
    <path d="M15 3h6v6M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
  </svg>
);
export const DraftIcon = (p: P) => (
  <svg {...svg(p)}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="18" r="2.4" />
    <path d="M6 8.4v7.2" strokeDasharray="2 2" />
    <path d="M18 15.6v-3" strokeDasharray="2 2" />
  </svg>
);

/* ---- status dot ---------------------------------------------------------- */

export type Tone =
  | "pass"
  | "fail"
  | "pending"
  | "none"
  | "active"
  | "paused";

const TONE_COLOR: Record<Tone, string> = {
  pass: "var(--color-success, #4ade80)",
  active: "var(--color-success, #4ade80)",
  fail: "var(--color-destructive, #fb2c36)",
  pending: "var(--color-warning, #ffbd38)",
  none: "color-mix(in srgb, var(--midground) 38%, transparent)",
  paused: "color-mix(in srgb, var(--midground) 38%, transparent)",
};

/** A 7px status dot; pending pulses (it is the "in flight" signal). */
export function Dot({ tone, title }: { tone: Tone; title?: string }) {
  const color = TONE_COLOR[tone];
  const pulse = tone === "pending";
  return (
    <span
      title={title}
      className="relative inline-grid shrink-0 place-items-center"
      style={{ width: 9, height: 9 }}
    >
      {pulse && (
        <motion.span
          aria-hidden
          className="absolute inset-0 rounded-full"
          style={{ background: color }}
          animate={{ opacity: [0.5, 0, 0.5], scale: [1, 1.9, 1] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <span
        className="relative rounded-full"
        style={{
          width: 7,
          height: 7,
          background: color,
          boxShadow:
            tone === "none" || tone === "paused"
              ? "none"
              : `0 0 7px ${color}`,
        }}
      />
    </span>
  );
}

/* ---- badge / pill -------------------------------------------------------- */

export function Badge({
  children,
  tone = "muted",
  className,
}: {
  children: ReactNode;
  tone?: "muted" | "accent" | "warn" | "danger" | "ok";
  className?: string;
}) {
  const styles: Record<string, string> = {
    muted: "text-text-tertiary border-border",
    accent:
      "text-midground border-[color-mix(in_srgb,var(--midground)_30%,transparent)]",
    warn: "text-[var(--color-warning,#ffbd38)] border-[color-mix(in_srgb,var(--color-warning,#ffbd38)_40%,transparent)]",
    danger:
      "text-[var(--color-destructive,#fb2c36)] border-[color-mix(in_srgb,var(--color-destructive,#fb2c36)_40%,transparent)]",
    ok: "text-[var(--color-success,#4ade80)] border-[color-mix(in_srgb,var(--color-success,#4ade80)_40%,transparent)]",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-[2px]",
        "font-mono-ui text-[0.58rem] uppercase tracking-[0.1em] leading-none",
        styles[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Mono +adds / -dels stat (tabular, color-coded). */
export function DiffStat({ adds, dels }: { adds: number; dels: number }) {
  return (
    <span className="font-mono-ui tabular text-[0.66rem] leading-none">
      <span style={{ color: "var(--color-success, #4ade80)" }}>+{adds}</span>{" "}
      <span style={{ color: "var(--color-destructive, #fb2c36)" }}>
        &minus;{dels}
      </span>
    </span>
  );
}

/* ---- header / labels ----------------------------------------------------- */

export function SectionLabel({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-1 pb-1.5 pt-1">
      <span className="font-mondwest text-display text-[0.66rem] tracking-[0.16em] text-text-tertiary">
        {children}
      </span>
      {right}
    </div>
  );
}

export function RefreshButton({
  loading,
  onClick,
}: {
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="Refresh"
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-full text-text-tertiary transition-colors hover:text-midground active:scale-90"
    >
      <span className={loading ? "animate-spin" : ""}>
        <RefreshIcon width={15} height={15} />
      </span>
    </button>
  );
}

/* ---- skeletons ----------------------------------------------------------- */

/** Shimmering placeholder block (transform/opacity only). */
export function Shimmer({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <motion.div
      className={cn("overflow-hidden rounded-md", className)}
      style={{
        background:
          "linear-gradient(100deg, color-mix(in srgb, var(--midground) 5%, transparent) 30%, color-mix(in srgb, var(--midground) 12%, transparent) 50%, color-mix(in srgb, var(--midground) 5%, transparent) 70%)",
        backgroundSize: "220% 100%",
        ...style,
      }}
      animate={{ backgroundPosition: ["120% 0", "-120% 0"] }}
      transition={{ duration: 1.25, repeat: Infinity, ease: "linear" }}
    />
  );
}

export function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border px-3 py-3">
      <Shimmer className="h-2.5 w-2.5 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Shimmer className="h-3 w-2/3" />
        <Shimmer className="h-2.5 w-2/5" />
      </div>
      <Shimmer className="h-3 w-10" />
    </div>
  );
}

export function PaneSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 px-3">
      {Array.from({ length: rows }).map((_, i) => (
        <RowSkeleton key={i} />
      ))}
    </div>
  );
}

/* ---- designed data states ------------------------------------------------ */

export function StateCard({
  icon: Icon,
  title,
  blurb,
  tone = "muted",
}: {
  icon: (p: P) => ReactNode;
  title: string;
  blurb?: string;
  tone?: "muted" | "danger";
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="mx-3 mt-6 flex flex-col items-center gap-4 rounded-2xl border border-border px-8 py-12 text-center"
      style={{
        background: "color-mix(in srgb, var(--midground) 3%, transparent)",
      }}
    >
      <div
        className={cn(
          "relative grid h-14 w-14 place-items-center rounded-2xl",
          tone === "danger"
            ? "text-[var(--color-destructive,#fb2c36)]"
            : "text-midground",
        )}
        style={{
          background: "color-mix(in srgb, var(--midground) 6%, transparent)",
        }}
      >
        <span className="arc-border" aria-hidden />
        <Icon width={26} height={26} />
      </div>
      <div>
        <h3 className="font-mondwest text-display text-base tracking-wide text-midground">
          {title}
        </h3>
        {blurb && (
          <p className="mx-auto mt-1.5 max-w-[32ch] text-[0.8rem] leading-relaxed text-text-tertiary">
            {blurb}
          </p>
        )}
      </div>
    </motion.div>
  );
}

/* ===========================================================================
   PullToRefresh, native-feeling pull at the top of the shell scroll.
   The scroll container is owned by the shell (an ancestor motion.div), so we
   find the nearest scrollable parent and engage only when it is at the top.
   Touchmove is bound non-passive so we can damp the page rubber-band.
   =========================================================================== */

const PULL_MAX = 92;
const PULL_TRIGGER = 64;

export function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh: () => void | Promise<void>;
  children: ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLDivElement>(null);
  const spinner = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const pulling = useRef(false);
  const pullRef = useRef(0);
  const refreshing = useRef(false);

  // Locate the scrollable ancestor once mounted.
  useEffect(() => {
    let el = wrap.current?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
        scroller.current = el;
        break;
      }
      el = el.parentElement;
    }
  }, []);

  // Paint the current pull distance with direct DOM writes — NO React state, so
  // dragging never triggers a pane re-render (the old per-frame setState was the
  // jank). Transform-only, runs on the compositor.
  const paint = (dist: number, animate: boolean) => {
    const c = content.current;
    const ind = indicator.current;
    const sp = spinner.current;
    if (c) {
      c.style.transition = animate
        ? "transform 0.32s cubic-bezier(0.16,1,0.3,1)"
        : "none";
      c.style.transform = `translate3d(0,${dist}px,0)`;
    }
    const progress = Math.min(1, dist / PULL_TRIGGER);
    if (ind) {
      ind.style.transition = animate ? "transform 0.32s cubic-bezier(0.16,1,0.3,1), opacity 0.2s" : "none";
      ind.style.transform = `translate3d(0,${dist - PULL_MAX}px,0)`;
      ind.style.opacity = String(progress);
    }
    if (sp && !refreshing.current) {
      sp.style.transform = `rotate(${progress * 270}deg)`;
    }
  };

  useEffect(() => {
    const node = wrap.current;
    if (!node) return;

    const onStart = (e: TouchEvent) => {
      if (refreshing.current) return;
      const sc = scroller.current;
      if (sc && sc.scrollTop > 0) return; // only at the very top
      startY.current = e.touches[0].clientY;
      pulling.current = true;
    };
    const onMove = (e: TouchEvent) => {
      if (!pulling.current || refreshing.current) return;
      const sc = scroller.current;
      if (sc && sc.scrollTop > 0) {
        pulling.current = false;
        pullRef.current = 0;
        paint(0, true);
        return;
      }
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0) {
        pullRef.current = 0;
        paint(0, false);
        return;
      }
      // True rubber-band resistance: stiffens as you pull (asymptotic toward
      // PULL_MAX), so it never feels 1:1 and matches the iOS spring feel.
      const damped = PULL_MAX * (1 - Math.exp(-dy / (PULL_MAX * 1.1)));
      pullRef.current = damped;
      paint(damped, false);
      if (dy > 6) e.preventDefault(); // stop the native overscroll glow
    };
    const onEnd = async () => {
      if (!pulling.current) return;
      pulling.current = false;
      if (pullRef.current >= PULL_TRIGGER) {
        refreshing.current = true;
        paint(PULL_TRIGGER, true);
        spinner.current?.classList.add("animate-spin-slow");
        try {
          await onRefresh();
        } finally {
          refreshing.current = false;
          spinner.current?.classList.remove("animate-spin-slow");
          pullRef.current = 0;
          paint(0, true);
        }
      } else {
        pullRef.current = 0;
        paint(0, true);
      }
    };

    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: false });
    node.addEventListener("touchend", onEnd, { passive: true });
    node.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", onEnd);
      node.removeEventListener("touchcancel", onEnd);
    };
  }, [onRefresh]);

  return (
    <div ref={wrap} className="relative">
      <div
        ref={indicator}
        className="pointer-events-none absolute inset-x-0 top-0 flex justify-center"
        style={{ height: PULL_MAX, transform: `translate3d(0,${-PULL_MAX}px,0)`, opacity: 0 }}
      >
        <span
          className="mt-3 grid h-8 w-8 place-items-center rounded-full border border-border text-midground"
          style={{
            background: "color-mix(in srgb, var(--background-base) 80%, transparent)",
            backdropFilter: "blur(8px)",
          }}
        >
          <span ref={spinner} style={{ willChange: "transform" }}>
            <RefreshIcon width={15} height={15} />
          </span>
        </span>
      </div>
      <div ref={content} style={{ willChange: "transform" }}>
        {children}
      </div>
    </div>
  );
}
