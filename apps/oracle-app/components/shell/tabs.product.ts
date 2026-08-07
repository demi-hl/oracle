import {
  AutomationIcon,
  ChartIcon,
  CheckIcon,
  HomeIcon,
  PlugIcon,
  TerminalIcon,
  PortfolioIcon,
  RouterIcon,
  ShieldIcon,
  SwapIcon,
} from "./icons";
import type { TabDef, TabId } from "./tab-types";
import { ApprovalsPane } from "@/components/oracle/ApprovalsPane";
import { CampaignsPane } from "@/components/oracle/CampaignsPane";
import { ConnectPane } from "@/components/oracle/ConnectPane";
import { CrossbookPane } from "@/components/oracle/CrossbookPane";
import { OracleHomePane } from "@/components/oracle/OracleHomePane";
import { PortfolioPane } from "@/components/oracle/PortfolioPane";
import { ReceiptsPane } from "@/components/oracle/ReceiptsPane";
import { SwapPane } from "@/components/oracle/SwapPane";
import { MarketsPane } from "@/components/oracle/MarketsPane";
import { FarmingMethodsPane } from "@/components/oracle/FarmingMethodsPane";
import { CliRuntimePane } from "@/components/oracle/CliRuntimePane";

/**
 * Oracle first, matching the CLI.
 *
 * Crossbook (on-chain equities best execution, the equities product) is a
 * separate product/protocol surface shipped inside Oracle (CLI + app + MCP
 * share one module). It is not a private desk feature.
 */
export const PRODUCT_TABS: TabDef[] = [
  { id: "tasks", label: "Oracle", shortLabel: "Oracle", Icon: HomeIcon, Pane: OracleHomePane },
  { id: "portfolio", label: "Portfolio", shortLabel: "Portfolio", Icon: PortfolioIcon, Pane: PortfolioPane },
  { id: "approvals", label: "Approvals", shortLabel: "Approvals", Icon: ShieldIcon, Pane: ApprovalsPane },
  { id: "swap", label: "Prepare", shortLabel: "Prepare", Icon: SwapIcon, Pane: SwapPane },
  { id: "equities", label: "Crossbook", shortLabel: "Crossbook", Icon: RouterIcon, Pane: CrossbookPane },
  { id: "cli", label: "CLI", shortLabel: "CLI", Icon: TerminalIcon, Pane: CliRuntimePane },
  { id: "farming", label: "Farming Methods", shortLabel: "Farming", Icon: ChartIcon, Pane: FarmingMethodsPane },
  { id: "connect", label: "Agent Connect", shortLabel: "Connect", Icon: PlugIcon, Pane: ConnectPane },
  { id: "receipts", label: "Receipts", shortLabel: "Receipts", Icon: CheckIcon, Pane: ReceiptsPane },
  { id: "campaigns", label: "Campaigns", shortLabel: "Campaigns", Icon: AutomationIcon, Pane: CampaignsPane },
  { id: "analytics", label: "Routes", shortLabel: "Routes", Icon: ChartIcon, Pane: MarketsPane },
];

export const PRODUCT_PRIMARY_TAB_IDS: TabId[] = [
  "tasks",
  "portfolio",
  "approvals",
  "swap",
  "equities",
  "cli",
];

export const PRODUCT_HIDDEN_FROM_MORE: TabId[] = [];
