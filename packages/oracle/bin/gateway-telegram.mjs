/**
 * Oracle Telegram Gateway — Grammy-based Telegram bot.
 * Receives messages, routes to Oracle agent, sends responses back.
 */
import { Bot } from "grammy";
import { routeToAgent } from "./gateway-agent.mjs";

export async function telegram(config) {
  const bot = new Bot(config.token);

  bot.command("start", (ctx) => ctx.reply("Oracle ready. Ask me anything — swap, bridge, portfolio, watch."));

  bot.on("message:text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const senderId = String(ctx.from?.id || chatId);
    const text = ctx.message.text;

    try {
      // Show typing indicator
      ctx.replyWithChatAction("typing").catch(() => {});

      const response = await routeToAgent({
        platform: "telegram",
        chatId,
        senderId,
        text,
        userName: ctx.from?.username || ctx.from?.first_name || "user",
      });

      if (response) await ctx.reply(response, { parse_mode: "Markdown" });
    } catch (err) {
      process.stderr.write(`telegram-gateway: ${err.message}\n`);
      await ctx.reply("Something went wrong. Try again.").catch(() => {});
    }
  });

  bot.start();
  return { platform: "telegram", bot };
}