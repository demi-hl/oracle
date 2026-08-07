import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Faithful port of `@nous-research/ui`'s `cn` (utils/index.ts): twMerge(clsx(...)).
 * The vendored design-system components below rely on tailwind-merge to resolve
 * conflicting utility classes when a caller passes an override `className`, so
 * this MUST layer twMerge — unlike the app's lighter `@/lib/utils` cn (clsx-only,
 * used by the shell where utility sets are disjoint).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
