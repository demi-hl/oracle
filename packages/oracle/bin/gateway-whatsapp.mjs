/**
 * Oracle WhatsApp Gateway — whatsapp-web.js based.
 * QR code pairing on first run, then persistent session.
 */
import { routeToAgent } from "./gateway-agent.mjs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const CONFIG_DIR = process.env.ORACLE_CONFIG_DIR || join(homedir(), ".config", "oracle");

function ensureDeps() {
  try {
    require.resolve("whatsapp-web.js");
    require.resolve("qrcode-terminal");
    return true;
  } catch {
    process.stderr.write("whatsapp-gateway: installing dependencies...\n");
    const r = spawnSync("npm", ["install", "whatsapp-web.js", "qrcode-terminal"], {
      cwd: join(CONFIG_DIR, "gateway"),
      stdio: "inherit",
      timeout: 60000,
    });
    return r.status === 0;
  }
}

export async function whatsapp(config) {
  if (!ensureDeps()) {
    process.stderr.write("whatsapp-gateway: failed to install dependencies\n");
    return { platform: "whatsapp", status: "failed" };
  }

  // Re-import after install
  const { Client, LocalAuth } = await import("whatsapp-web.js");
  const { generate } = await import("qrcode-terminal");
    authStrategy: new LocalAuth({ dataPath: join(CONFIG_DIR, ".wwebjs_auth") }),
    puppeteer: { headless: true, args: ["--no-sandbox"] },
  });

  client.on("qr", (qr) => {
    process.stderr.write("\nWhatsApp: scan this QR code in WhatsApp → Linked Devices:\n\n");
    generate(qr, { small: true });
    process.stderr.write("\n");
  });

  client.on("ready", () => {
    process.stderr.write("whatsapp-gateway: connected\n");
  });

  client.on("message", async (msg) => {
    if (msg.fromMe) return;
    const chatId = msg.from;
    const senderId = msg.author || msg.from;
    const text = msg.body;

    try {
      const response = await routeToAgent({
        platform: "whatsapp",
        chatId,
        senderId,
        text,
        userName: msg._data?.notifyName || "user",
      });

      if (response) {
        // Strip markdown for WhatsApp
        const plain = response.replace(/\*\*/g, "*").replace(/```[\s\S]*?```/g, "[code]").replace(/`/g, "");
        await msg.reply(plain);
      }
    } catch (err) {
      process.stderr.write(`whatsapp-gateway: ${err.message}\n`);
    }
  });

  await client.initialize();
  return { platform: "whatsapp", client };
}