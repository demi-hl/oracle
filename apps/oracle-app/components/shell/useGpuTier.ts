"use client";

import { useSyncExternalStore } from "react";

/**
 * Dependency-free port of `@nous-research/ui`'s `useGpuTier`.
 *
 * The DS hook is backed by nanostores; we don't want that dep, so this uses a
 * module-level store + `useSyncExternalStore` (SSR-safe, no hydration
 * mismatch — server and first client render both read tier 0).
 *
 * Tiers:
 *   0 — no WebGL / software rasterizer (SwiftShader, llvmpipe) /
 *       prefers-reduced-motion / detection not yet run. Consumers skip the
 *       animated layer.
 *   1 — low-end GPU (integrated / mobile).
 *   2 — capable GPU.
 *
 * Detection is scheduled AFTER first paint (requestIdleCallback) so the
 * potentially-expensive WebGL probe never blocks initial render — same
 * pessimistic-default-then-upgrade strategy as the DS.
 */
type GpuTier = 0 | 1 | 2;

let tier: GpuTier = 0;
let scheduled = false;
const listeners = new Set<() => void>();

const SOFTWARE_PATTERNS =
  /swiftshader|llvmpipe|softpipe|software|microsoft basic/i;
const LOW_END_PATTERNS =
  /intel.*hd|intel.*uhd|intel.*iris|mali|adreno\s?[1-5]|powervr|apple gpu/i;

function setTier(next: GpuTier) {
  if (next === tier) return;
  tier = next;
  for (const l of listeners) l();
}

function detect() {
  if (typeof window === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  let gl: WebGLRenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    gl = (canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
  } catch {
    return; // hardened contexts throw rather than return null
  }
  if (!gl) return;

  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(
    ext
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER),
  );
  gl.getExtension("WEBGL_lose_context")?.loseContext();

  if (SOFTWARE_PATTERNS.test(renderer)) return; // stay tier 0
  setTier(LOW_END_PATTERNS.test(renderer) ? 1 : 2);
}

function schedule() {
  if (scheduled || typeof window === "undefined") return;
  scheduled = true;
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => detect(), { timeout: 1000 });
  } else {
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => detect()),
    );
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  schedule();
  return () => {
    listeners.delete(cb);
  };
}

export function useGpuTier(): GpuTier {
  return useSyncExternalStore(
    subscribe,
    () => tier,
    () => 0 as GpuTier,
  );
}
