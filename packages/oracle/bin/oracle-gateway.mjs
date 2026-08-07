#!/usr/bin/env node
/**
 * Oracle Gateway — standalone messaging server.
 * Connects Oracle's agent to Telegram, Discord, WhatsApp, Signal.
 * No Hermes required.
 */
import { createServer } from "node:http";
import { env } from "node:process";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const CONFIG_DIR = env.ORACLE_CONFIG_DIR || join(homedir(), ".config", "oracle");
const GATEWAY_CONFIG = join(CONFIG_DIR, "gateway.json");

function loadConfig() {
  if (!existsSync(GATEWAY_CONFIG)) return { platforms: {} };
  return JSON.parse(readFileSync(GATEWAY_CONFIG, "utf8"));
}

async function main() {
  const config = loadConfig();
  const platforms = [];

  // Telegram
  if (config.platforms?.telegram) {
    const { telegram } = await import("./gateway-telegram.mjs");
    platforms.push(telegram(config.platforms.telegram));
  }

  // Discord
  if (config.platforms?.discord) {
    const { discord } = await import("./gateway-discord.mjs");
    platforms.push(discord(config.platforms.discord));
  }

  // WhatsApp
  if (config.platforms?.whatsapp) {
    const { whatsapp } = await import("./gateway-whatsapp.mjs");
    platforms.push(whatsapp(config.platforms.whatsapp));
  }

  // Signal
  if (config.platforms?.signal) {
    const { signal_ } = await import("./gateway-signal.mjs");
    platforms.push(signal_(config.platforms.signal));
  }

  if (platforms.length === 0) {
    process.stderr.write("oracle-gateway: no platforms configured. Run 'oracle setup telegram' first.\n");
    // Still start health endpoint
  }

  await Promise.all(platforms);
  process.stderr.write(`oracle-gateway: ${platforms.length} platform(s) connected\n`);

  // Health check endpoint
  createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", platforms: Object.keys(config.platforms || {}) }));
  }).listen(env.ORACLE_GATEWAY_PORT || 9270, "127.0.0.1");
}

main().catch((err) => {
  process.stderr.write(`oracle-gateway: ${err.message}\n`);
  process.exit(1);
});