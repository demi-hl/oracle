import type { ComponentType, SVGProps } from "react";

/**
 * The tab contract, shared by the product registry and the operator registry.
 *
 * This file is the seam that lets the PUBLIC app ship without the operator
 * cockpit. `TabId` is a plain string alias rather than a closed union so the
 * two registries can be compiled independently: the public build never
 * references an operator id, and the operator build adds its ids without
 * editing anything the public build owns.
 */
export type TabId = string;

export interface TabDef {
  id: TabId;
  /** Full label (More sheet, a11y). */
  label: string;
  /** Tighter label for the bottom bar. */
  shortLabel: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  Pane: ComponentType;
}
