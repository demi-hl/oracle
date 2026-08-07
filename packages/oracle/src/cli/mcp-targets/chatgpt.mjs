import fs from "node:fs";
import path from "node:path";
import { fakeHome, report } from "./shared.mjs";

export const CHATGPT_CANNOT_SIGN =
  "ChatGPT is hosted and can NEVER sign or reach your keys. This connector is read/prepare only; anything it prepares is unsigned until you sign it locally.";

function openApiDoc() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Oracle Public (read/prepare)",
      version: "1.0.0",
      description: "Secret-free public surface for hosted clients. " + CHATGPT_CANNOT_SIGN,
    },
    servers: [{ url: "https://REPLACE-WITH-YOUR-TUNNEL" }],
    paths: {
      "/public/health": { get: { operationId: "publicHealth", summary: "Health check", responses: { "200": { description: "ok" } } } },
      "/public/config": { get: { operationId: "publicConfig", summary: "Public config", responses: { "200": { description: "ok" } } } },
      "/public/connect/request": { post: { operationId: "connectRequest", summary: "Build a connect request (unsigned)", responses: { "200": { description: "unsigned request artifact" } } } },
      "/public/connect/assemble": { post: { operationId: "connectAssemble", summary: "Assemble an unsigned grant artifact", responses: { "200": { description: "unsigned grant artifact" } } } },
      "/public/grants/active": { post: { operationId: "grantsActive", summary: "List active grants (read)", responses: { "200": { description: "ok" } } } },
      "/public/grants/get": { post: { operationId: "grantsGet", summary: "Get a grant by id (read)", responses: { "200": { description: "ok" } } } },
    },
  };
}

export async function installChatgpt({ printOnly = false } = {}) {
  const doc = openApiDoc();
  const target = path.join(fakeHome(), ".config", "oracle", "connectors", "chatgpt-openapi.json");
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (!printOnly) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  const instructions = [
    CHATGPT_CANNOT_SIGN, "",
    "Next steps:",
    "  1. oracle public serve",
    "  2. Expose 127.0.0.1:8799 through YOUR HTTPS tunnel (cloudflared, tailscale funnel, etc.).",
    "     Oracle will not create tunnels for you.",
    "  3. Paste the OpenAPI spec into a GPT Action, or add the tunnel URL as a developer-mode MCP connector.",
    printOnly ? "" : `  Spec written to: ${target}`,
  ].filter(Boolean).join("\n");
  return {
    ok: true,
    ...report(printOnly ? "printed" : "written", {
      path: target, print: doc, instructions, cannotSign: CHATGPT_CANNOT_SIGN,
    }),
  };
}
