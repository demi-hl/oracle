"use client";

import { useEffect, useMemo, useState } from "react";
import {
  WATCH_CATEGORIES,
  createCampaign,
  listCampaigns,
  saveCampaign,
  updateCampaignStatus,
  type CampaignMode,
  type CampaignStatus,
  type OracleCampaign,
} from "./surfaceStorage";

const ORACLE_BLUE = "#7CC4FF";
const ORACLE_MUTE = "#9FB8D2";
const HAIRLINE = "rgba(124,196,255,.14)";

const MODES: { id: CampaignMode; label: string; detail: string }[] = [
  { id: "alert", label: "Alert", detail: "Record alert intent" },
  { id: "prepare", label: "Prepare", detail: "Prepare exact action" },
  { id: "owner_arm", label: "Arm request", detail: "Ask owner before action" },
];

function expiresIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function statusColor(status: CampaignStatus) {
  if (status === "watching") return ORACLE_BLUE;
  if (status === "paused") return "#F3C879";
  return "#DDF1FF66";
}

/**
 * The stored status stays `watching` because that is the state name whatever
 * runtime consumes these rows will act on. What it must not do is SAY
 * "watching" to a user in an app that has no watcher: nothing here polls a
 * trigger, and the record only becomes "expired" because a timestamp passed.
 * Display the storage state honestly instead.
 */
function statusLabel(status: CampaignStatus): string {
  if (status === "watching") return "saved";
  if (status === "paused") return "paused";
  return "expired";
}

function CampaignCard({ campaign, selected, now, onSelect, onStatus }: {
  campaign: OracleCampaign;
  selected: boolean;
  now: number;
  onSelect: () => void;
  onStatus: (status: CampaignStatus) => void;
}) {
  const expired = now > 0 && Date.parse(campaign.expiresAt) <= now;
  const status = expired && campaign.status === "watching" ? "expired" : campaign.status;
  return (
    <article className="border-b border-[#7CC4FF]/10 p-4 last:border-b-0" style={{ background: selected ? "rgba(124,196,255,.055)" : "transparent" }}>
      <button type="button" onClick={onSelect} className="w-full text-left">
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono-ui text-[0.5rem] uppercase tracking-[0.16em] text-[#7CC4FF]/46">{campaign.category}</span>
          <span className="flex items-center gap-1.5 font-mono-ui text-[0.5rem] uppercase tracking-[0.12em]" style={{ color: statusColor(status) }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor(status) }} />
            {statusLabel(status)}
          </span>
        </div>
        <h2 className="mt-3 text-[0.88rem] text-[#EEF8FF]">{campaign.label}</h2>
        <p className="mt-1.5 line-clamp-2 text-[0.66rem] leading-relaxed text-[#DDF1FF]/46">{campaign.trigger}</p>
      </button>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => onStatus(campaign.status === "paused" ? "watching" : "paused")} className="border border-[#7CC4FF]/14 px-2 py-1 font-mono-ui text-[0.5rem] uppercase tracking-[0.11em] text-[#9FB8D2]">
          {campaign.status === "paused" ? "Resume" : "Pause"}
        </button>
        <button type="button" onClick={() => onStatus("expired")} className="border border-[#7CC4FF]/14 px-2 py-1 font-mono-ui text-[0.5rem] uppercase tracking-[0.11em] text-[#9FB8D2]">
          Expire
        </button>
      </div>
    </article>
  );
}

export function CampaignsPane() {
  const [campaigns, setCampaigns] = useState<OracleCampaign[]>([]);
  const [now, setNow] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [label, setLabel] = useState("HYPE price watch");
  const [category, setCategory] = useState<(typeof WATCH_CATEGORIES)[number]>("price");
  const [trigger, setTrigger] = useState("Alert when HYPE moves more than 3% in 15 minutes");
  const [exactAction, setExactAction] = useState("Prepare swap quote only. No broadcast.");
  const [mode, setMode] = useState<CampaignMode>("alert");
  const [ttl, setTtl] = useState("60");
  const [notify, setNotify] = useState(true);
  const [status, setStatus] = useState("local campaign store");

  useEffect(() => {
    const load = () => {
      const next = listCampaigns();
      setCampaigns(next);
      setNow(Date.now());
      setSelectedId((current) => current ?? next[0]?.id ?? null);
    };
    load();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    window.addEventListener("oracle-campaigns-updated", load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("oracle-campaigns-updated", load);
    };
  }, []);

  const selected = useMemo(
    () => campaigns.find((item) => item.id === selectedId) ?? campaigns[0] ?? null,
    [campaigns, selectedId],
  );
  const stats = useMemo(() => {
    const active = campaigns.filter((item) => item.status === "watching" && Date.parse(item.expiresAt) > now).length;
    const arm = campaigns.filter((item) => item.mode === "owner_arm").length;
    const alert = campaigns.filter((item) => item.mode === "alert").length;
    return { active, arm, alert };
  }, [campaigns, now]);

  const submit = () => {
    const minutes = Math.max(1, Math.min(1440, Number(ttl) || 60));
    const campaign = createCampaign({
      category,
      label: label.trim() || "Untitled watch",
      trigger: trigger.trim() || "Notify on matching signal",
      exactAction: exactAction.trim() || "Alert only",
      mode,
      expiresAt: expiresIn(minutes),
      notify,
    });
    const next = saveCampaign(campaign);
    setCampaigns(next);
    setSelectedId(campaign.id);
    setStatus("campaign saved");
  };

  const changeStatus = (id: string, nextStatus: CampaignStatus) => {
    const next = updateCampaignStatus(id, nextStatus);
    setCampaigns(next);
    setStatus(`${nextStatus} saved`);
  };

  return (
    <section className="mx-auto flex h-full w-full max-w-6xl flex-col gap-5 overflow-y-auto p-4 text-[#DDF1FF] sm:p-6">
      <header className="grid gap-4 border-b border-[#7CC4FF]/10 pb-5 lg:grid-cols-[1fr_auto]">
        <div>
          <p className="font-mono-ui text-[0.56rem] uppercase tracking-[0.2em] text-[#7CC4FF]/58">Watch Campaigns</p>
          <h1 className="mt-2 font-display-ui text-[2.15rem] leading-none tracking-[-0.05em] text-[#EEF8FF] sm:text-[3rem]">
            watch, alert, then request owner action
          </h1>
          <p className="mt-3 max-w-2xl text-[0.78rem] leading-relaxed text-[#DDF1FF]/56">
            Campaigns bind a trigger, category, exact action text, notification setting, and expiry. This app stores that intent and nothing else: it does not watch triggers, evaluate them, or notify. No scheduler, no signature, no broadcast.
          </p>
        </div>
        <section className="grid min-w-[260px] grid-cols-3 gap-px overflow-hidden border border-[#7CC4FF]/12 bg-[#7CC4FF]/10" aria-label="Campaign stats">
          {[
            ["saved", stats.active],
            ["alerts", stats.alert],
            ["arm req", stats.arm],
          ].map(([name, value]) => (
            <div key={name} className="bg-[#0B1018] p-3 text-center">
              <div className="font-mono-ui text-[1rem] text-[#EEF8FF]">{value}</div>
              <div className="mt-1 font-mono-ui text-[0.48rem] uppercase tracking-[0.13em] text-[#7CC4FF]/42">{name}</div>
            </div>
          ))}
        </section>
      </header>

      <div className="grid gap-5 lg:grid-cols-[390px_1fr]">
        <section className="border border-[#7CC4FF]/12 bg-[#0B1018]/82 p-4" aria-labelledby="campaign-builder-heading">
          <p id="campaign-builder-heading" className="font-mono-ui text-[0.56rem] uppercase tracking-[0.18em] text-[#7CC4FF]/50">Campaign builder</p>
          <div className="mt-4 grid gap-3">
            <label className="grid gap-1.5">
              <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Label</span>
              <input value={label} onChange={(event) => setLabel(event.target.value)} className="h-11 border border-[#7CC4FF]/16 bg-[#080D13] px-3 text-[0.78rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Category</span>
                <select value={category} onChange={(event) => setCategory(event.target.value as (typeof WATCH_CATEGORIES)[number])} className="h-11 border border-[#7CC4FF]/16 bg-[#080D13] px-3 font-mono-ui text-[0.68rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50">
                  {WATCH_CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5">
                <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">TTL minutes</span>
                <input value={ttl} onChange={(event) => setTtl(event.target.value)} inputMode="numeric" className="h-11 border border-[#7CC4FF]/16 bg-[#080D13] px-3 font-mono-ui text-[0.68rem] text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50" />
              </label>
            </div>
            <label className="grid gap-1.5">
              <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Trigger</span>
              <textarea value={trigger} onChange={(event) => setTrigger(event.target.value)} rows={3} className="border border-[#7CC4FF]/16 bg-[#080D13] px-3 py-2 text-[0.76rem] leading-relaxed text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50" />
            </label>
            <label className="grid gap-1.5">
              <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Exact action</span>
              <textarea value={exactAction} onChange={(event) => setExactAction(event.target.value)} rows={3} className="border border-[#7CC4FF]/16 bg-[#080D13] px-3 py-2 text-[0.76rem] leading-relaxed text-[#DDF1FF] outline-none focus:border-[#7CC4FF]/50" />
            </label>
            <div className="grid gap-2">
              <span className="font-mono-ui text-[0.55rem] uppercase tracking-[0.14em] text-[#9FB8D2]">Mode</span>
              <div className="grid gap-2 sm:grid-cols-3">
                {MODES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setMode(item.id)}
                    className="border px-3 py-2 text-left transition-colors"
                    style={{ borderColor: item.id === mode ? ORACLE_BLUE : HAIRLINE, background: item.id === mode ? "rgba(124,196,255,.08)" : "transparent" }}
                  >
                    <div className="font-mono-ui text-[0.55rem] uppercase tracking-[0.12em]" style={{ color: item.id === mode ? ORACLE_BLUE : ORACLE_MUTE }}>{item.label}</div>
                    <div className="mt-1 text-[0.62rem] text-[#DDF1FF]/42">{item.detail}</div>
                  </button>
                ))}
              </div>
            </div>
            {/* This app has no scheduler, no watcher, and no Notification path.
                The checkbox records a preference for whatever runtime later
                reads these rows; it cannot itself deliver an alert. The old
                label promised a message that would never arrive, on the surface
                where a user is most likely to walk away expecting to be told. */}
            <label className="flex items-start gap-2 border border-[#7CC4FF]/10 px-3 py-2 text-[0.72rem] text-[#DDF1FF]/58">
              <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} className="mt-0.5" />
              <span>
                Request notification when a runtime evaluates this
                <span className="mt-0.5 block text-[0.62rem] leading-relaxed text-[#DDF1FF]/40">
                  Saved as intent. This app does not watch or notify.
                </span>
              </span>
            </label>
            <button type="button" onClick={submit} className="h-11 bg-[#7CC4FF] px-4 font-mono-ui text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-[#0B1018]">
              Save campaign
            </button>
          </div>
        </section>

        <section className="grid min-h-[600px] overflow-hidden border border-[#7CC4FF]/12 bg-[#0B1018]/82 lg:grid-cols-[310px_1fr]">
          <aside className="border-b border-[#7CC4FF]/10 lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between border-b border-[#7CC4FF]/10 px-4 py-3">
              <span className="font-mono-ui text-[0.54rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Saved</span>
              <span className="font-mono-ui text-[0.54rem] uppercase tracking-[0.16em] text-[#DDF1FF]/46">{campaigns.length}</span>
            </div>
            {campaigns.length === 0 ? (
              <div className="grid min-h-[260px] place-items-center px-5 text-center">
                <div>
                  <p className="text-[0.82rem] text-[#DDF1FF]/72">No campaigns yet</p>
                  <p className="mt-1.5 text-[0.66rem] leading-relaxed text-[#DDF1FF]/42">Save one to bind a trigger to an exact action.</p>
                </div>
              </div>
            ) : (
              <div>{campaigns.map((campaign) => <CampaignCard key={campaign.id} campaign={campaign} selected={campaign.id === selected?.id} now={now} onSelect={() => setSelectedId(campaign.id)} onStatus={(nextStatus) => changeStatus(campaign.id, nextStatus)} />)}</div>
            )}
          </aside>

          <main className="min-w-0 p-4 sm:p-5">
            {selected ? (
              <div className="grid gap-4">
                <section className="grid gap-px overflow-hidden border border-[#7CC4FF]/10 bg-[#7CC4FF]/10 sm:grid-cols-4">
                  {[
                    ["mode", selected.mode],
                    ["category", selected.category],
                    ["notify", selected.notify ? "yes" : "no"],
                    ["expires", new Date(selected.expiresAt).toLocaleString()],
                  ].map(([name, value]) => (
                    <div key={name} className="bg-[#0B1018] p-3">
                      <div className="font-mono-ui text-[0.5rem] uppercase tracking-[0.16em] text-[#7CC4FF]/42">{name}</div>
                      <div className="mt-1 text-[0.72rem] text-[#DDF1FF]">{value}</div>
                    </div>
                  ))}
                </section>
                <section className="border border-[#7CC4FF]/12 p-4">
                  <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Trigger</p>
                  <p className="mt-3 text-[0.82rem] leading-relaxed text-[#DDF1FF]/72">{selected.trigger}</p>
                </section>
                <section className="border border-[#7CC4FF]/12 p-4">
                  <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Exact action</p>
                  <p className="mt-3 text-[0.82rem] leading-relaxed text-[#DDF1FF]/72">{selected.exactAction}</p>
                </section>
                <section className="border border-[#7CC4FF]/12 bg-[#7CC4FF]/[0.035] p-4">
                  <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em] text-[#7CC4FF]/48">Custody wall</p>
                  <p className="mt-3 text-[0.72rem] leading-relaxed text-[#DDF1FF]/54">
                    This public campaign object cannot schedule execution. Prepare and arm request modes only record the exact action for owner review.
                  </p>
                </section>
                <pre className="max-h-[280px] overflow-auto border border-[#7CC4FF]/12 bg-[#080D13] p-4 text-[0.66rem] leading-relaxed text-[#DDF1FF]/68"><code>{JSON.stringify(selected, null, 2)}</code></pre>
              </div>
            ) : (
              <div className="grid min-h-[420px] place-items-center text-center text-[#DDF1FF]/52">Select a campaign to inspect.</div>
            )}
          </main>
        </section>
      </div>

      <div className="font-mono-ui text-[0.52rem] uppercase tracking-[0.14em] text-[#7CC4FF]/42">{status}</div>
    </section>
  );
}

export default CampaignsPane;
