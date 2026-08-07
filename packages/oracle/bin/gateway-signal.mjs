import { routeToAgent } from "./gateway-agent.mjs";

export async function signal_(config) {
  process.stderr.write("signal-gateway: requires signal-cli binary\n");
  process.stderr.write("signal-gateway: not built yet — use Telegram or Discord for now\n");
  return { platform: "signal", status: "stub" };
}