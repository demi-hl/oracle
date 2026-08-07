// L2Beat — L2 scaling TVL and activity data (no API key).

import { httpJson } from "../http.mjs";

export const L2BEAT_API = "https://api.l2beat.com";

function base(opts = {}) {
  return (opts.baseUrl || process.env.L2BEAT_API_URL || L2BEAT_API).replace(/\/$/, "");
}

export async function l2beatHealth(opts = {}) {
  try {
    const data = await httpJson(`${base(opts)}/api/scaling/tvl`, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 15_000,
    });
    return { ok: data && typeof data.totalUsd === "string", provider: "l2beat-tvl" };
  } catch (e) {
    return { ok: false, provider: "l2beat-tvl", error: String(e.message || e).slice(0, 120) };
  }
}

export async function l2beatTvl(args = {}, opts = {}) {
  const data = await httpJson(`${base(opts)}/api/scaling/tvl`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
  if (args.project) {
    const name = String(args.project).toLowerCase();
    const projects = data?.projects || {};
    const found = Object.entries(projects).find(([k]) => String(k).toLowerCase() === name);
    return found ? { [found[0]]: found[1] } : {};
  }
  return data;
}

export async function l2beatActivity(args = {}, opts = {}) {
  return httpJson(`${base(opts)}/api/scaling/activity`, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? 20_000,
  });
}
