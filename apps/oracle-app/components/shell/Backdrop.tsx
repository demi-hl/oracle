"use client";

import type { CSSProperties } from "react";
import { useGpuTier } from "./useGpuTier";

/** Optional filler texture. The upstream asset
 *  (`@nous-research/ui/assets/filler-bg0.webp`) was never vendored into
 *  public/, so this 404'd on every page load. It is a decorative layer at
 *  opacity 0.033 behind a difference blend, so the correct behaviour when it
 *  is absent is to render nothing rather than to request a missing file. */
const FILLER_BG_URL = "/filler-bg0.webp";
const FILLER_BG_AVAILABLE = false;

/**
 * The Hermes signature "alive" background. Ported from the desktop dashboard's
 * `src/components/Backdrop.tsx` — a fixed, full-screen, pointer-events-none
 * z-stack that every theme repaints via CSS custom properties:
 *
 *   z-1   bg = `var(--background-base)`, mix-blend-mode driven by
 *         `--component-backdrop-bg-blend-mode` (default `difference`).
 *   z-2   bundled filler-bg WebP, inverted, opacity 0.033, difference.
 *   z-99  warm top-left vignette (`var(--warm-glow)`), opacity 0.22, lighten.
 *   z-200 FG inversion = `var(--foreground)` (opaque white in Nous Blue,
 *         alpha-0 in dark themes), mix-blend-mode: difference. This is the
 *         layer that flips the app into "light mode" for inverted themes; for
 *         normal dark themes its alpha is 0 so it is a no-op. Placed above
 *         every UI overlay z-index so portaled elements invert too.
 *   z-201 noise grain (SVG, ~55% opacity × `--noise-opacity-mul`, color-dodge)
 *         — GPU-gated and animated. Sits above the inversion layer by design
 *         so the grain is not flipped.
 *
 * `useGpuTier()` returns 0 when WebGL is unavailable, the renderer is a
 * software rasterizer, or `prefers-reduced-motion: reduce` is set. We skip the
 * animated noise layer in that case so low-power / accessibility-conscious
 * dense UI stays crisp.
 */
export function Backdrop() {
  const gpuTier = useGpuTier();

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[1]"
        style={
          {
            backgroundColor: "var(--background-base)",
            mixBlendMode: "var(--component-backdrop-bg-blend-mode, difference)",
          } as unknown as CSSProperties
        }
      />

      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[2]"
        style={
          {
            mixBlendMode:
              "var(--component-backdrop-filler-blend-mode, difference)",
            opacity: "var(--component-backdrop-filler-opacity, 0)",
            backgroundImage: "var(--theme-asset-bg)",
            backgroundSize: "var(--component-backdrop-background-size, cover)",
            backgroundPosition:
              "var(--component-backdrop-background-position, center)",
          } as unknown as CSSProperties
        }
      >
        {FILLER_BG_AVAILABLE && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            alt=""
            className="h-[150dvh] w-auto min-w-[100dvw] object-cover object-left-top invert theme-default-filler"
            fetchPriority="low"
            src={FILLER_BG_URL}
          />
        )}
      </div>

      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[99]"
        style={{
          background:
            "radial-gradient(ellipse at 0% 0%, transparent 60%, var(--warm-glow) 100%)",
          mixBlendMode: "lighten",
          opacity: 0.14,
        }}
      />

      {/* Foreground inversion layer. With `--foreground-alpha: 0` (dark themes)
          the layer is fully transparent; with alpha 1 + opaque white it
          inverts the entire stack below it (Nous Blue "light mode"). z-200 so
          it sits above every portaled UI overlay. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundColor: "var(--foreground)",
          mixBlendMode: "difference",
          zIndex: 200,
        }}
      />

      {gpuTier > 0 && (
        <div
          aria-hidden
          className="noise-grain pointer-events-none fixed inset-[-5%] z-[201]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' fill='%23eaeaea' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E\")",
            backgroundSize: "512px 512px",
            mixBlendMode: "color-dodge",
            opacity: "calc(0.2 * var(--noise-opacity-mul, 1))",
          }}
        />
      )}
    </>
  );
}
