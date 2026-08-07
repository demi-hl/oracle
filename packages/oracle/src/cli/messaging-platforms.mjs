// Hermes messaging platforms Oracle can configure.
// Values stay lowercase. Secrets stay in Hermes profile .env, never printed.

export const MESSAGING_PLATFORMS = Object.freeze([
  {
    key: "telegram",
    name: "telegram",
    hermes: ["gateway", "setup"],
    required: ["TELEGRAM_BOT_TOKEN"],
    optional: ["TELEGRAM_ALLOWED_USERS", "TELEGRAM_PROXY"],
    note: "dms · groups · topics",
  },
  {
    key: "discord",
    name: "discord",
    hermes: ["gateway", "setup"],
    required: ["DISCORD_BOT_TOKEN"],
    optional: ["DISCORD_ALLOWED_USERS"],
    note: "dms · channels · threads",
  },
  {
    key: "slack",
    name: "slack",
    hermes: ["gateway", "setup"],
    required: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    optional: ["SLACK_ALLOWED_USERS"],
    note: "socket mode",
  },
  {
    key: "whatsapp",
    name: "whatsapp",
    hermes: ["whatsapp"],
    required: [],
    optional: ["WHATSAPP_ALLOWED_USERS", "WHATSAPP_MODE"],
    note: "qr bridge",
  },
  {
    key: "whatsapp-cloud",
    name: "whatsapp cloud",
    hermes: ["whatsapp-cloud"],
    required: [],
    optional: [],
    note: "business cloud api",
  },
  {
    key: "signal",
    name: "signal",
    hermes: ["gateway", "setup"],
    required: ["SIGNAL_HTTP_URL", "SIGNAL_ACCOUNT"],
    optional: ["SIGNAL_ALLOWED_USERS"],
    note: "signal-cli rest bridge",
  },
  {
    key: "matrix",
    name: "matrix",
    hermes: ["gateway", "setup"],
    required: ["MATRIX_HOMESERVER", "MATRIX_ACCESS_TOKEN", "MATRIX_USER_ID"],
    optional: ["MATRIX_ALLOWED_USERS"],
    note: "rooms · dms",
  },
  {
    key: "mattermost",
    name: "mattermost",
    hermes: ["gateway", "setup"],
    required: ["MATTERMOST_URL", "MATTERMOST_TOKEN"],
    optional: ["MATTERMOST_ALLOWED_USERS"],
    note: "channels · dms",
  },
  {
    key: "email",
    name: "email",
    hermes: ["gateway", "setup"],
    required: ["EMAIL_ADDRESS", "EMAIL_PASSWORD", "EMAIL_IMAP_HOST", "EMAIL_SMTP_HOST"],
    optional: [],
    note: "imap/smtp mailbox",
  },
  {
    key: "bluebubbles",
    name: "bluebubbles",
    hermes: ["gateway", "setup"],
    required: [],
    optional: [],
    note: "imessage via bluebubbles",
  },
  {
    key: "photon",
    name: "photon",
    hermes: ["photon"],
    required: ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"],
    optional: ["PHOTON_ALLOWED_USERS", "PHOTON_HOME_CHANNEL"],
    note: "imessage via spectrum (no mac)",
  },
  {
    key: "homeassistant",
    name: "homeassistant",
    hermes: ["gateway", "setup"],
    required: ["HASS_URL", "HASS_TOKEN"],
    optional: [],
    note: "smart home",
  },
  {
    key: "webhook",
    name: "webhook",
    hermes: ["gateway", "setup"],
    required: [],
    optional: [],
    note: "http ingress",
  },
  {
    key: "api-server",
    name: "api server",
    hermes: ["gateway", "setup"],
    required: [],
    optional: [],
    note: "local http api",
  },
  {
    key: "dingtalk",
    name: "dingtalk",
    hermes: ["gateway", "setup"],
    required: [],
    optional: [],
    note: "dingtalk bot",
  },
  {
    key: "feishu",
    name: "feishu",
    hermes: ["gateway", "setup"],
    required: [],
    optional: [],
    note: "feishu / lark",
  },
  {
    key: "wecom",
    name: "wecom",
    hermes: ["gateway", "setup"],
    required: [],
    optional: [],
    note: "wecom",
  },
  {
    key: "weixin",
    name: "weixin",
    hermes: ["gateway", "setup"],
    required: [],
    optional: [],
    note: "weixin",
  },
  {
    key: "qqbot",
    name: "qqbot",
    hermes: ["gateway", "setup"],
    required: [],
    optional: [],
    note: "qq bot",
  },
]);

function normalize(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "-");
}

export function listMessagingPlatforms() {
  return MESSAGING_PLATFORMS.slice();
}

export function findMessagingPlatform(query) {
  const q = normalize(query);
  if (!q) return null;
  for (const p of MESSAGING_PLATFORMS) {
    if (p.key === q) return p;
    if (normalize(p.name) === q) return p;
  }
  return null;
}

export function renderSetupMenu({ profile = "oracle", statuses = {} } = {}) {
  const lines = [
    "oracle setup",
    "",
    "one oracle. many models. every connected channel.",
    `profile: ${profile}`,
    "",
    "messaging platforms:",
    "",
  ];
  for (const p of MESSAGING_PLATFORMS) {
    const st = statuses[p.key] || "unset";
    lines.push(`  ${p.key.padEnd(16)} ${String(st).padEnd(8)}  ${p.note}`);
  }
  lines.push("");
  lines.push("commands:");
  lines.push("  oracle setup                 this menu");
  lines.push("  oracle setup messaging       open hermes gateway setup");
  lines.push("  oracle setup telegram        configure telegram bot token");
  lines.push("  oracle setup discord         configure discord bot token");
  lines.push("  oracle setup status          show configured platforms (no secrets)");
  lines.push("  oracle setup gateway         start/status hermes gateway");
  lines.push("  /setup                       same menu inside chat");
  lines.push("");
  lines.push("notes:");
  lines.push("  tokens stay in the hermes profile .env on this machine");
  lines.push("  oracle never prints bot tokens or app secrets");
  lines.push("  after setup: hermes -p oracle gateway restart");
  return lines.join("\n") + "\n";
}

export default {
  MESSAGING_PLATFORMS,
  listMessagingPlatforms,
  findMessagingPlatform,
  renderSetupMenu,
};
