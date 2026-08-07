/**
 * Durable cross-session memory for the Oracle standalone agent.
 * Read/write ~/.config/oracle/memory.json per session.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = process.env.ORACLE_CONFIG_DIR || path.join(homedir(), ".config", "oracle");
const MEMORY_FILE = path.join(CONFIG_DIR, "memory.json");
const CHAR_LIMIT = 2_200;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadStore() {
  ensureDir(CONFIG_DIR);
  try {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
  }
}

function saveStore(store) {
  ensureDir(CONFIG_DIR);
  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function addMemory(key, content) {
  const store = loadStore();
  const existing = store.entries.findIndex((e) => e.key === key);
  if (existing >= 0) {
    store.entries[existing] = { key, content, addedAt: new Date().toISOString() };
  } else {
    store.entries.push({ key, content, addedAt: new Date().toISOString() });
  }
  while (JSON.stringify(store.entries).length > CHAR_LIMIT && store.entries.length > 1) {
    store.entries.shift();
  }
  saveStore(store);
}

export function removeMemory(key) {
  const store = loadStore();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.key !== key);
  if (store.entries.length < before) {
    saveStore(store);
    return { ok: true };
  }
  return { ok: false };
}

export function getMemoryBlock() {
  const store = loadStore();
  if (store.entries.length === 0) return "";
  const total = JSON.stringify(store.entries).length;
  const pct = Math.round((total / CHAR_LIMIT) * 100);
  const lines = store.entries.map((e) => `${e.key}: ${e.content}`);
  return [
    "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
    `MEMORY [${pct}% \u2014 ${total}/${CHAR_LIMIT} chars]`,
    "\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550",
    ...lines,
  ].join("\n");
}

export const MEMORY_TOOLS = [
  {
    type: "function",
    function: {
      name: "memory_add",
      description: "Save a durable fact to memory for future sessions.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Short unique key" },
          content: { type: "string", description: "The fact to remember" },
        },
        required: ["key", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_remove",
      description: "Remove a memory entry by key.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "The key to remove" },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
];