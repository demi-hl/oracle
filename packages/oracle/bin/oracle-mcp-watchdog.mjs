#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const INTERVAL_MS = 120_000; // 2 min
const ports = { data: 8799, exec: 8792 };

async function check(port) {
  return new Promise((resolve) => {
    // Try localhost first, then Tailscale IP
    let resolved = false;
    const c1 = spawn("ss", ["-tln"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    let out = "";
    c1.stdout.on("data", (d) => (out += d.toString()));
    c1.on("close", () => {
      const up = out.includes(`:${port} `);
      resolved = up;
      resolve(up);
    });
    c1.on("error", () => resolve(false));
  });
}

async function loop() {
  const dead = [];
  for (const [name, port] of Object.entries(ports)) {
    if (!(await check(port))) dead.push(`${name}:${port}`);
  }
  if (dead.length) {
    process.stderr.write(`oracle-watchdog: ${dead.join(", ")} down — run 'oracle mcp restart' to recover\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--once")) {
    await loop();
    return;
  }
  process.stderr.write(`oracle-watchdog: checking every ${INTERVAL_MS / 1000}s (--once for one-shot)\n`);
  loop(); // first check
  setInterval(loop, INTERVAL_MS).unref();
}

main();