/**
 * Oracle Discord Gateway — discord.js-based bot.
 */
import { Client, GatewayIntentBits } from "discord.js";
import { routeToAgent } from "./gateway-agent.mjs";

export async function discord(config) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    const chatId = msg.channel.id;
    const senderId = msg.author.id;
    const text = msg.content;

    try {
      const isDM = !msg.guild;
      const mentioned = msg.mentions.has(client.user.id);
      if (!isDM && !mentioned) return; // only respond to DMs or @mentions

      msg.channel.sendTyping().catch(() => {});

      const response = await routeToAgent({
        platform: "discord",
        chatId,
        senderId,
        text: text.replace(`<@${client.user.id}>`, "").trim(),
        userName: msg.author.username,
      });

      if (response) await msg.reply(response).catch(() => {});
    } catch (err) {
      process.stderr.write(`discord-gateway: ${err.message}\n`);
    }
  });

  await client.login(config.token);
  return { platform: "discord", client };
}