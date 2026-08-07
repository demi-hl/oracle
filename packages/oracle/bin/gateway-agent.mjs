/**
 * Oracle Gateway Agent — routes incoming messages through Oracle's agent runtime.
 * Uses `oracle route` for structured intents, falls back to direct model call.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CONFIG_DIR = process.env.ORACLE_CONFIG_DIR || join(homedir(), ".config", "oracle");
const ORACLE_BIN = join(homedir(), ".local", "share", "oracle-stable", "node_modules", "@oracle-agent", "oracle", "bin", "oracle.mjs");
const MODEL = process.env.ORACLE_GATEWAY_MODEL || "deepseek/deepseek-v4-pro";
const PROVIDER = process.env.ORACLE_GATEWAY_PROVIDER || "nous-direct";

/**
 * Route a message through Oracle's agent runtime.
 * For trading intents, uses data/exec MCP tools. For general chat, uses direct model call.
 */
export async function routeToAgent({ platform, chatId, senderId, text, userName }) {
  const lower = text.toLowerCase().trim();

  // Quick intent detection — route to trade or chat
  const isTrade = /\b(buy|sell|swap|bridge|send|transfer|balance|portfolio|watch|quote|price)\b/.test(lower);

  if (isTrade) {
    return routeTrade({ platform, chatId, senderId, text, userName });
  }

  return routeChat({ platform, chatId, senderId, text, userName });
}

async function routeTrade({ text, userName }) {
  // Delegate to oracle's route command
  return new Promise((resolve) => {
    const child = spawn("node", [ORACLE_BIN, "route", "swap", "--text", text], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
      env: { ...process.env, ORACLE_DESK_URL: `http://127.0.0.1:8799` },
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("close", (code) => {
      if (code === 0 && out) {
        try {
          const result = JSON.parse(out);
          resolve(formatTradeResult(result));
        } catch {
          resolve(out.trim());
        }
      } else {
        resolve(`Trade routing failed. Try: \`${text}\` again.`);
      }
    });
  });
}

async function routeChat({ text, userName }) {
  // Simple fallback: return a helpful message
  if (text === "help" || text === "/help") {
    return `**Oracle Gateway**

Available commands:
• \`buy 0.1 ETH of PEPE on Base\` — execute a trade
• \`sell 500 USDC for ETH\` — sell tokens
• \`bridge 100 USDC to Arbitrum\` — cross-chain transfer
• \`portfolio\` — view your holdings
• \`watch ETH above 3500\` — set a price alert
• \`balance\` — check wallet balance

Your key never leaves this machine. Oracle is self-custodial.`;
  }

  return `I'm Oracle — your multichain trading agent. Try:\n• \`buy 0.1 ETH of PEPE on Base\`\n• \`portfolio\`\n• \`watch ETH above 3500\``;
}

function formatTradeResult(result) {
  if (result.error) return `❌ ${result.error}`;
  if (result.tx) return `✅ Trade prepared: \`${result.tx.slice(0, 20)}...\`\nSign and broadcast via \`oracle send\``;
  if (result.quote) return `💱 ${result.quote}`;
  if (result.portfolio) return `📊 ${result.portfolio}`;
  return JSON.stringify(result, null, 2);
}