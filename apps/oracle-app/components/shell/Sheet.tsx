"use client";

import { AnimatePresence, motion, type PanInfo, type Variants } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { CloseIcon } from "./icons";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Extra classes on the sheet panel (e.g. max-height tweaks). */
  className?: string;
}

const SPRING = { type: "spring", stiffness: 380, damping: 38 } as const;

// Variants drive enter AND exit: the container's label (hidden/visible/hidden)
// propagates to the backdrop + panel children, so both animate out before
// AnimatePresence unmounts the tree.
const ROOT_V: Variants = { hidden: {}, visible: {} };
const BACKDROP_V: Variants = { hidden: { opacity: 0 }, visible: { opacity: 1 } };
const PANEL_V: Variants = { hidden: { y: "100%" }, visible: { y: 0 } };

/**
 * Frosted bottom sheet with a drag-to-dismiss handle. Used for the model
 * picker, the theme switcher, and the "More" tab overflow. Respects the home
 * indicator via safe-area inset, traps Escape, and is reduced-motion aware via
 * the shell's MotionConfig.
 */
export function Sheet({ open, onClose, title, children, className }: SheetProps) {
  // Portal to <body> so the sheet escapes the z-30 header / footer stacking
  // contexts it is declared inside. `mounted` avoids an SSR portal mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onDragEnd = (_e: unknown, info: PanInfo) => {
    if (info.offset.y > 120 || info.velocity.y > 650) onClose();
  };

  // iOS WKWebView runs with Keyboard resize:None, so the layout viewport never
  // shrinks when the keyboard opens — a bottom-anchored sheet stays pinned
  // BEHIND the keyboard. Track visualViewport.height and clamp the sheet
  // container to it so the panel floats just above the keyboard.
  const [vh, setVh] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setVh(vv.height);
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-x-0 top-0 z-[120] flex flex-col justify-end"
          style={{ height: vh ? `${vh}px` : "100dvh" }}
          variants={ROOT_V}
          initial="hidden"
          animate="visible"
          exit="hidden"
        >
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
            variants={BACKDROP_V}
            transition={{ duration: 0.25 }}
            onClick={onClose}
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={cn(
              "relative mx-auto w-full max-w-[560px]",
              "flex flex-col max-h-full overflow-hidden",
              "rounded-t-[calc(var(--theme-radius)+10px)] border-t border-border",
              "shadow-[0_-18px_48px_-12px_rgba(0,0,0,0.7)]",
              className,
            )}
            style={{
              background:
                "color-mix(in srgb, var(--background-base) 86%, transparent)",
              backdropFilter: "blur(22px) saturate(150%)",
              WebkitBackdropFilter: "blur(22px) saturate(150%)",
              paddingBottom: "calc(env(safe-area-inset-bottom) + 14px)",
            }}
            variants={PANEL_V}
            transition={SPRING}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={onDragEnd}
          >
            <div className="flex justify-center pt-2.5 pb-1">
              <span className="h-1 w-10 rounded-full bg-[color-mix(in_srgb,var(--midground)_30%,transparent)]" />
            </div>

            {title && (
              <div className="flex items-center justify-between px-4 pb-2 pt-1">
                <span className="text-display font-mondwest text-[0.72rem] tracking-[0.14em] text-text-tertiary">
                  {title}
                </span>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={onClose}
                  className="grid h-11 w-11 place-items-center rounded-full text-text-tertiary transition-colors hover:text-midground active:scale-90"
                >
                  <CloseIcon width={15} height={15} />
                </button>
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2.5 pb-2">
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
