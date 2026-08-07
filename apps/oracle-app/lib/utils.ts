import { clsx, type ClassValue } from "clsx";

/** Classname combiner. clsx is already a dependency; the DS `cn` in the
 *  desktop app also layers tailwind-merge, but the shell uses disjoint
 *  utility sets so plain clsx is enough (and one fewer dep). */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
