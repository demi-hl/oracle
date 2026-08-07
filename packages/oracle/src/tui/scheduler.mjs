/**
 * Cron scheduler for the Oracle standalone agent.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";

const CONFIG_DIR = process.env.ORACLE_CONFIG_DIR || path.join(homedir(), ".config", "oracle");
const CRON_FILE = path.join(CONFIG_DIR, "cron.json");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadStore() {
  ensureDir(CONFIG_DIR);
  try {
    return JSON.parse(fs.readFileSync(CRON_FILE, "utf8"));
  } catch {
    return { version: 1, jobs: [] };
  }
}

function saveStore(store) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CRON_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function parseSchedule(schedule) {
  const s = String(schedule || "").toLowerCase().trim();
  const everyMin = s.match(/^every\s+(\d+)\s*m/i);
  if (everyMin) return parseInt(everyMin[1]) * 60_000;
  const everyHour = s.match(/^every\s+(\d+)\s*h/i);
  if (everyHour) return parseInt(everyHour[1]) * 3_600_000;
  if (s.includes("daily")) return 86_400_000;
  if (s.includes("hourly")) return 3_600_000;
  const parts = s.split(/\s+/);
  if (parts.length === 5) return 60_000;
  return null;
}

export function listJobs() {
  return loadStore().jobs;
}

export function addJob(job) {
  const store = loadStore();
  const id = `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const interval = parseSchedule(job.schedule) || 3_600_000;
  const newJob = {
    ...job,
    id,
    createdAt: new Date().toISOString(),
    nextRunAt: new Date(Date.now() + interval).toISOString(),
  };
  store.jobs.push(newJob);
  saveStore(store);
  return newJob;
}

export function removeJob(id) {
  const store = loadStore();
  const before = store.jobs.length;
  store.jobs = store.jobs.filter((j) => j.id !== id);
  if (store.jobs.length < before) {
    saveStore(store);
    return true;
  }
  return false;
}

export function toggleJob(id, enabled) {
  const store = loadStore();
  const job = store.jobs.find((j) => j.id === id);
  if (!job) return false;
  job.enabled = enabled;
  saveStore(store);
  return true;
}

export function markRun(id) {
  const store = loadStore();
  const job = store.jobs.find((j) => j.id === id);
  if (!job) return;
  job.lastRunAt = new Date().toISOString();
  const interval = parseSchedule(job.schedule) || 3_600_000;
  const base = job.lastRunAt ? new Date(job.lastRunAt).getTime() : Date.now();
  job.nextRunAt = new Date(base + interval).toISOString();
  saveStore(store);
}

export function createScheduler(agentRunFn) {
  const emitter = new EventEmitter();
  const timers = new Map();

  function start() {
    const store = loadStore();
    for (const job of store.jobs) {
      if (!job.enabled) continue;
      const interval = parseSchedule(job.schedule);
      if (!interval) continue;
      const timer = setInterval(async () => {
        try {
          emitter.emit("run", { id: job.id, name: job.name });
          await agentRunFn(job.prompt, job.skills);
          markRun(job.id);
          emitter.emit("complete", { id: job.id, name: job.name });
        } catch (err) {
          emitter.emit("error", { id: job.id, name: job.name, error: err });
        }
      }, interval);
      timers.set(job.id, timer);
    }
    emitter.emit("started", { count: timers.size });
  }

  function stop() {
    for (const [id, timer] of timers) {
      clearInterval(timer);
      timers.delete(id);
    }
    emitter.emit("stopped");
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    start,
    stop,
    add: (job) => {
      const j = addJob(job);
      if (j.enabled) {
        const interval = parseSchedule(j.schedule);
        if (interval) {
          const timer = setInterval(async () => {
            try {
              emitter.emit("run", { id: j.id, name: j.name });
              await agentRunFn(j.prompt, j.skills);
              markRun(j.id);
              emitter.emit("complete", { id: j.id, name: j.name });
            } catch (err) {
              emitter.emit("error", { id: j.id, name: j.name, error: err });
            }
          }, interval);
          timers.set(j.id, timer);
        }
      }
      return j;
    },
    remove: (id) => {
      const timer = timers.get(id);
      if (timer) { clearInterval(timer); timers.delete(id); }
      return removeJob(id);
    },
    list: listJobs,
  };
}

export const CRON_TOOLS = [
  {
    type: "function",
    function: {
      name: "cron_add",
      description: "Schedule a recurring agent job.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable name" },
          schedule: { type: "string", description: "'every 30m', 'daily', 'every 6h'" },
          prompt: { type: "string", description: "Agent prompt to run on schedule" },
          skills: { type: "array", items: { type: "string" }, description: "Optional skill names" },
        },
        required: ["name", "schedule", "prompt"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cron_list",
      description: "List all scheduled cron jobs.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "cron_remove",
      description: "Remove a cron job by id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job id from cron_list" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];