"use client";

import { BUILTIN_THEMES, useTheme, type DashboardTheme } from "@/lib/themes";
import type { ThemeListEntry } from "@/lib/themes";
import { Sheet } from "./Sheet";
import { CheckIcon } from "./icons";
import { haptic } from "./haptics";
import { cn } from "@/lib/utils";

/**
 * Mobile theme picker. Adapted from the desktop `ThemeSwitcher.tsx`: same
 * `useTheme()` wiring (localStorage key `oracle-theme`, set via the
 * ported provider) and the same 3-stop swatch preview logic. Rewritten as a
 * dependency-free bottom sheet instead of the DS Button/ListItem/BottomSheet
 * stack (which we don't ship). Reachable from the app title long-press and the
 * Settings tab.
 */
export function ThemeSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { themeName, availableThemes, setTheme } = useTheme();

  // The active theme decides whether the whole UI is being run through the
  // z-200 `mix-blend-mode: difference` inversion layer (Nous Blue "light
  // mode"). The swatches are portaled BELOW that layer, so when an inverting
  // theme is active every swatch gets flipped on screen. We counter-invert the
  // swatch fills in that case so each one renders its true, labeled colors.
  const activeInverts =
    (BUILTIN_THEMES[themeName]?.palette.foreground.alpha ?? 0) === 1;

  return (
    <Sheet open={open} onClose={onClose} title="Theme">
      <ul role="listbox" aria-label="Theme" className="flex flex-col gap-0.5">
        {availableThemes.map((th) => (
          <ThemeRow
            key={th.name}
            entry={th}
            active={th.name === themeName}
            invertSwatch={activeInverts}
            onSelect={() => {
              haptic(10);
              setTheme(th.name);
              onClose();
            }}
          />
        ))}
      </ul>
    </Sheet>
  );
}

function ThemeRow({
  entry,
  active,
  invertSwatch,
  onSelect,
}: {
  entry: ThemeListEntry;
  active: boolean;
  invertSwatch: boolean;
  onSelect: () => void;
}) {
  const paletteTheme = BUILTIN_THEMES[entry.name] ?? entry.definition;
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={active}
        onClick={onSelect}
        className={cn(
          "relative flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-colors",
          active
            ? "bg-[color-mix(in_srgb,var(--midground)_10%,transparent)]"
            : "active:bg-[color-mix(in_srgb,var(--midground)_6%,transparent)]",
        )}
      >
        {active && (
          <span
            aria-hidden
            className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-midground"
          />
        )}
        {paletteTheme ? <Swatch theme={paletteTheme} invert={invertSwatch} /> : <PlaceholderSwatch />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-mondwest text-display truncate text-[0.82rem] tracking-wide text-midground">
            {entry.label}
          </span>
          {entry.description && (
            <span className="truncate text-[0.72rem] text-text-tertiary">
              {entry.description}
            </span>
          )}
        </span>
        <CheckIcon
          width={16}
          height={16}
          className={cn(
            "shrink-0 text-midground transition-opacity",
            active ? "opacity-100" : "opacity-0",
          )}
        />
      </button>
    </li>
  );
}

function Swatch({ theme, invert }: { theme: DashboardTheme; invert: boolean }) {
  // Inverted themes (Nous Blue) author pre-inversion, so they opt into an
  // explicit `swatchColors` triplet that mirrors the on-screen result;
  // everything else falls back to the raw palette hexes.
  const [c1, c2, c3] = theme.swatchColors ?? [
    theme.palette.background.hex,
    theme.palette.midground.hex,
    theme.palette.warmGlow,
  ];
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 overflow-hidden rounded-full border border-border"
      // When an inverting theme (Nous Blue) is active, the whole sheet sits
      // below the z-200 difference layer that flips it. Counter-invert here so
      // the swatch shows its true colors instead of the flipped complement.
      style={invert ? { filter: "invert(1)" } : undefined}
    >
      <span className="flex-1" style={{ background: c1 }} />
      <span className="flex-1" style={{ background: c2 }} />
      <span className="flex-1" style={{ background: c3 }} />
    </span>
  );
}

function PlaceholderSwatch() {
  return (
    <span
      aria-hidden
      className="h-7 w-7 shrink-0 rounded-full border border-dashed border-border"
    />
  );
}

/** Curated canvas colors for the background override. Each keeps the active
 *  theme's accents intact and only repaints the page background. */
const BG_PRESETS: { value: string; label: string }[] = [
  { value: "#041c1c", label: "Teal" },
  { value: "#000000", label: "Black" },
  { value: "#0a0a1f", label: "Midnight" },
  { value: "#0e0e0e", label: "Graphite" },
  { value: "#0b1410", label: "Forest" },
  { value: "#1a0a06", label: "Ember" },
  { value: "#15101f", label: "Plum" },
  { value: "#1a0f15", label: "Rosewood" },
];

/**
 * Background-color override picker. Applies a canvas color ON TOP of the
 * active theme (accents unchanged), persisted via the theme provider. The
 * first option clears the override so the theme's own background wins.
 */
export function BackgroundSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { bgOverride, setBgOverride } = useTheme();

  return (
    <Sheet open={open} onClose={onClose} title="Background">
      <div className="flex flex-col gap-4 px-1 pb-2">
        <button
          type="button"
          onClick={() => {
            haptic(10);
            setBgOverride("");
          }}
          className={cn(
            "flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-colors",
            !bgOverride
              ? "bg-[color-mix(in_srgb,var(--midground)_10%,transparent)]"
              : "active:bg-[color-mix(in_srgb,var(--midground)_6%,transparent)]",
          )}
        >
          <span
            aria-hidden
            className="h-7 w-7 shrink-0 rounded-full border border-dashed border-border"
          />
          <span className="flex-1 text-[0.84rem] text-midground">
            Theme default
          </span>
          <CheckIcon
            width={16}
            height={16}
            className={cn(
              "shrink-0 text-midground transition-opacity",
              !bgOverride ? "opacity-100" : "opacity-0",
            )}
          />
        </button>

        <div className="grid grid-cols-4 gap-3 px-2">
          {BG_PRESETS.map((p) => {
            const active =
              bgOverride.toLowerCase() === p.value.toLowerCase();
            return (
              <button
                key={p.value}
                type="button"
                aria-label={p.label}
                onClick={() => {
                  haptic(10);
                  setBgOverride(p.value);
                }}
                className="flex flex-col items-center gap-1"
              >
                <span
                  className={cn(
                    "h-11 w-11 rounded-full border transition-all",
                    active
                      ? "border-midground ring-2 ring-[color-mix(in_srgb,var(--midground)_40%,transparent)]"
                      : "border-border",
                  )}
                  style={{ background: p.value }}
                />
                <span className="text-[0.62rem] text-text-tertiary">
                  {p.label}
                </span>
              </button>
            );
          })}
        </div>

        <label className="flex items-center gap-3 rounded-[var(--radius-md)] border border-border px-3 py-2.5">
          <span
            className="h-7 w-7 shrink-0 rounded-full border border-border"
            style={{ background: bgOverride || "var(--background-base)" }}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[0.84rem] text-midground">Custom</span>
            <span className="font-mono-ui text-[0.62rem] text-text-tertiary">
              {bgOverride || "tap to pick a color"}
            </span>
          </span>
          <input
            type="color"
            value={bgOverride || "#041c1c"}
            onChange={(e) => setBgOverride(e.target.value)}
            className="h-9 w-9 shrink-0 cursor-pointer rounded-md border border-border bg-transparent"
          />
        </label>
      </div>
    </Sheet>
  );
}
