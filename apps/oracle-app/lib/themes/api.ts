import type { ThemeListResponse } from "./types";

/**
 * Theme-sync shim.
 *
 * The desktop `context.tsx` talks to a Hermes web-server endpoint
 * (`@/lib/api`) to merge user YAML themes and persist the active theme
 * server-side. This mobile app ships ONLY the 8 built-in themes and has no
 * such backend, so these are deliberate no-ops:
 *
 *   - `getThemes()` returns empty (`active: ""`, `themes: []`). In
 *     `context.tsx` both `if (resp.active)` and `if (resp.themes?.length)`
 *     are then falsy, so the server-merge effect is inert — `localStorage`
 *     (key `oracle-theme`) and `BUILTIN_THEMES` govern instead.
 *   - `setTheme()` resolves void; persistence is local-only.
 *
 * This keeps the ported palette / CSS-var math in `context.tsx` byte-for-byte
 * identical to desktop without rewriting it.
 */
export const api = {
  async getThemes(): Promise<ThemeListResponse> {
    return { active: "", themes: [] };
  },
  async setTheme(_name: string): Promise<void> {
    /* local-only; nothing to persist server-side */
  },
};
