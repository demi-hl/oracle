import type { TabDef, TabId } from "./tab-types";
import {
  PRODUCT_TABS,
  PRODUCT_PRIMARY_TAB_IDS,
  PRODUCT_HIDDEN_FROM_MORE,
} from "./tabs.product";

export type { TabDef, TabId };

export const TABS: TabDef[] = PRODUCT_TABS;
export const PRIMARY_TAB_IDS: TabId[] = PRODUCT_PRIMARY_TAB_IDS;

export const TAB_MAP: Record<TabId, TabDef> = Object.fromEntries(
  TABS.map((t) => [t.id, t]),
) as Record<TabId, TabDef>;

export function getTab(id: TabId): TabDef {
  return TAB_MAP[id];
}

export const PRIMARY_TABS: TabDef[] = PRIMARY_TAB_IDS.map(getTab);
export const SECONDARY_TABS: TabDef[] = TABS.filter((t) => !PRIMARY_TAB_IDS.includes(t.id));
export const HIDDEN_FROM_MORE: TabId[] = PRODUCT_HIDDEN_FROM_MORE;
export const ALL_TABS: TabDef[] = [...PRIMARY_TABS, ...SECONDARY_TABS];
/**
 * Oracle opens on the ask box, matching the CLI.
 *
 * Bare `oracle` drops you into a prompt, not a dashboard. The app had drifted
 * into a tab bar where chat sat seventh, which answers "what is this product"
 * differently depending on which surface you touched. Portfolio, approvals, and
 * routes are answers Oracle gives, not destinations that outrank asking it.
 */
export const DEFAULT_TAB_ID: TabId = "tasks";
