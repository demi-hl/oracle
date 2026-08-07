/**
 * Oracle Gateway — WhatsApp and Signal stubs.
 * WhatsApp requires whatsapp-web.js (QR pairing).
 * Signal requires signal-cli (external binary).
 */
import { routeToAgent } from "./gateway-agent.mjs";

export async function whatsapp(config) {
  process.stderr.write("whatsapp-gateway: requires 'npm install whatsapp-web.js qrcode-terminal'\n");
  process.stderr.write("whatsapp-gateway: not built yet — use Telegram or Discord for now\n");
  return { platform: "whatsapp", status: "stub" };
}

export async function signal_(config) {
  process.stderr.write("signal-gateway: requires signal-cli binary\n");
  process.stderr.write("signal-gateway: not built yet — use Telegram or Discord for now\n");
  return { platform: "signal", status: "stub" };
}