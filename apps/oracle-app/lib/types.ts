// Shared shapes between API routes and panel components.

export type Repo = {
  name: string;
  description: string | null;
  pushedAt: string;
  url: string;
};

export type BotStatus = {
  reachable: boolean;
  name: string | null;
  status: string | null;
  restarts: number | null;
  unstableRestarts: number | null;
  uptimeMs: number | null;
  cpu: number | null;
  memBytes: number | null;
  pnl: { available: false; reason: string };
  error?: string;
};

export type FleetHost = {
  host: string;
  label: string;
  up: boolean;
  latencyMs: number | null;
  local: boolean;
};

export type BuildJob = {
  name: string;
  status: string;
  uptimeMs: number | null;
  cpu: number | null;
  memBytes: number | null;
};

export type Builds = {
  available: boolean;
  jobs: BuildJob[];
  note?: string;
};

export type DecisionLog = {
  available: boolean;
  date: string | null;
  shipped: string[];
  decided: string[];
  note?: string;
};

export type CaptureInbox = {
  available: boolean;
  countToday: number;
  files: string[];
  note?: string;
};

export type CronJob = {
  id: string;
  name: string;
  schedule: string;
  lastStatus: string | null;
  enabled: boolean;
  nextRunAt: string | null;
};

export type CronList = {
  available: boolean;
  jobs: CronJob[];
  note?: string;
};

export type ApiEnvelope<T> = {
  data: T | null;
  fetchedAt: string;
  error?: string;
};
