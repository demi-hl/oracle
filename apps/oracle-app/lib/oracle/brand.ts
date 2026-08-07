export const ORACLE_PRODUCT = {
  name: "Oracle",
  wordmark: "Oracle",
  attribution: "runs on your own machines",
  posture: "PREPARE-ONLY",
  description: "One task in. The right specialist out. Keyless, prepare-only.",
} as const;

export const ORACLE_APP_IDS = {
  web: "ai.oracle.agent",
} as const;

export const ORACLE_PALETTE = {
  background: "#0B1018",
  accent: "#7CC4FF",
} as const;

export const ORACLE_NAV_LABELS = {
  tasks: "Oracle",
  portfolio: "Portfolio",
  swap: "Prepare",
  analytics: "Routes",
} as const;

export const ORACLE_BRAND = {
  product: ORACLE_PRODUCT,
  appIds: ORACLE_APP_IDS,
  palette: ORACLE_PALETTE,
  navLabels: ORACLE_NAV_LABELS,
} as const;

export type OraclePlatform = keyof typeof ORACLE_APP_IDS;
export type OraclePosture = typeof ORACLE_PRODUCT.posture;
