import fs from "node:fs";
import path from "node:path";

const PROVIDERS = Object.freeze({
  openrouter: {
    key: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/auto",
  },
  openai: {
    key: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
  },
  xai: {
    key: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4-latest",
  },
  deepseek: {
    key: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  gemini: {
    key: "GEMINI_API_KEY",
    alternateKey: "GOOGLE_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
  },
});

const OAUTH_PROVIDERS = Object.freeze({
  "anthropic-oauth": {
    key: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
    protocol: "anthropic-messages",
  },
  "openai-codex": {
    key: "OPENAI_API_KEY",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    model: "gpt-5.4",
    protocol: "responses",
  },
  "xai-oauth": {
    key: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4-latest",
    protocol: "responses",
  },
});

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function providerFromEnv(env, stored) {
  const explicit = String(env.ORACLE_PROVIDER || stored.provider || "").trim().toLowerCase();
  if (explicit) return explicit;
  if (env.ORACLE_BASE_URL || stored.baseUrl) return "custom";
  for (const [name, preset] of Object.entries(PROVIDERS)) {
    if (env[preset.key] || (preset.alternateKey && env[preset.alternateKey])) return name;
  }
  return null;
}

export function standaloneConfigFromEnv(
  env = process.env,
  stored = {},
  oauthAvailable = () => false,
  apiKeyResolver = () => "",
) {
  const provider = providerFromEnv(env, stored);
  if (!provider) return null;

  const oauthPreset = OAUTH_PROVIDERS[provider];
  const preset = PROVIDERS[provider] || oauthPreset;
  const apiKeyEnv = String(env.ORACLE_API_KEY_ENV || stored.apiKeyEnv || "");
  const apiKey = String(
    env.ORACLE_API_KEY ||
    (apiKeyEnv && env[apiKeyEnv]) ||
    (preset && (env[preset.key] || (preset.alternateKey && env[preset.alternateKey]))) ||
    apiKeyResolver(provider) ||
    "",
  );
  const baseUrl = String(
    oauthPreset
      ? oauthPreset.baseUrl
      : provider === "custom"
        ? (env.ORACLE_BASE_URL || stored.baseUrl || "")
        : (preset?.baseUrl || ""),
  ).replace(/\/+$/, "");
  const model = String(env.ORACLE_MODEL || stored.model || preset?.model || "");
  if (!baseUrl || !model) return null;
  const hasOAuth = Boolean(oauthPreset && oauthAvailable(provider));
  if (oauthPreset && !hasOAuth) return null;
  if (!oauthPreset && provider !== "custom" && !apiKey) return null;

  return {
    kind: "standalone",
    provider,
    model,
    baseUrl,
    ...(hasOAuth ? { authType: "oauth", protocol: oauthPreset.protocol } : { apiKey }),
    contextLength: positiveInteger(env.ORACLE_CONTEXT_LENGTH || stored.contextLength, 128000),
    reasoningEffort: String(env.ORACLE_REASONING_EFFORT || stored.reasoningEffort || "high"),
  };
}

function setupReason(extra = "") {
  return [
    "Oracle runs its own native chat — no Hermes or external agent required.",
    "Set OPENROUTER_API_KEY, run `oracle auth login claude|codex|grok`, or configure a custom OpenAI-compatible endpoint.",
    "`oracle harness detect` finds any Agent Plugins-compatible clients installed on this machine.",
    extra,
  ].filter(Boolean).join("\n");
}

function remoteConfigFromEnv(env = process.env, stored = {}) {
  if (env.ORACLE_PUBLIC_DESKTOP === "1" || env.ORACLE_REMOTE_COMPUTE_DISABLE === "1") return null;
  const requested = String(env.ORACLE_CHAT_BACKEND || stored.backend || "auto").trim().toLowerCase();
  const host = String(env.ORACLE_COMPUTE_HOST || stored.computeHost || "").trim();
  if (!["remote", "arch"].includes(requested) && !env.ORACLE_COMPUTE_HOST) return null;
  if (!host) return null;
  const user = String(env.ORACLE_COMPUTE_USER || stored.computeUser || "").trim();
  const p = String(env.ORACLE_COMPUTE_PATH || stored.computePath || "$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin").trim();
  return { kind: "remote", host, user, path: p };
}

/** Known harnesses Oracle can detect. Ordered: prefer Oracle-native first. */
const KNOWN_HARNESSES = Object.freeze([
  { name: "oracle", bin: "oracle", label: "Oracle Native (default)", kind: "oracle" },
  { name: "hermes", bin: "hermes", label: "Hermes Agent", kind: "hermes" },
  { name: "opencode", bin: "opencode", label: "OpenCode", kind: "mcp" },
  { name: "claude", bin: "claude", label: "Claude Code", kind: "mcp" },
  { name: "codex", bin: "codex", label: "OpenAI Codex CLI", kind: "mcp" },
  { name: "cursor", bin: "cursor", label: "Cursor IDE", kind: "mcp" },
  { name: "windsurf", bin: "windsurf", label: "Windsurf", kind: "mcp" },
  { name: "aider", bin: "aider", label: "Aider", kind: "mcp" },
  { name: "continue", bin: "continue", label: "Continue", kind: "mcp" },
]);

function which(bin) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const c = path.join(dir, bin);
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

/**
 * Scan PATH for installed Agent Plugins-compatible harnesses.
 * Returns objects: { name, bin, label, kind, path }
 */
export function detectInstalledHarnesses() {
  const found = [];
  for (const h of KNOWN_HARNESSES) {
    if (h.name === "oracle") { found.push({ ...h, path: process.argv[1] || "oracle" }); continue; }
    const p = which(h.bin);
    if (p) found.push({ ...h, path: p });
  }
  return found;
}

export function resolveChatBackend({
  env = process.env,
  hermes = { ok: false },
  storedConfig = null,
  oauthAvailable = () => false,
  apiKeyResolver = () => "",
} = {}) {
  const requested = String(env.ORACLE_CHAT_BACKEND || storedConfig?.backend || "auto").trim().toLowerCase();
  const remote = remoteConfigFromEnv(env, storedConfig || {});

  if (requested === "remote" || requested === "arch") {
    return remote
      ? { kind: "remote", config: remote }
      : { kind: "unconfigured", reason: setupReason(`${requested} compute backend was requested, but no compute host is configured.`) };
  }

  const standalone = standaloneConfigFromEnv(env, storedConfig || {}, oauthAvailable, apiKeyResolver);

  if (requested === "standalone") {
    return standalone
      ? { kind: "standalone", config: standalone }
      : { kind: "unconfigured", reason: setupReason("ORACLE_CHAT_BACKEND=standalone was requested, but no standalone model is configured.") };
  }

  if (requested === "hermes") {
    return hermes?.ok
      ? { kind: "hermes", bin: hermes.bin }
      : { kind: "unconfigured", reason: setupReason("ORACLE_CHAT_BACKEND=hermes was requested, but Hermes was not found.") };
  }

  // Any named harness: check if it's installed
  if (requested !== "auto") {
    for (const h of KNOWN_HARNESSES) {
      if (h.name === requested) {
        const p = which(h.bin);
        if (p) return { kind: "harness", harness: { ...h, path: p } };
        return { kind: "unconfigured", reason: setupReason(`ORACLE_CHAT_BACKEND=${requested} was requested, but ${h.bin} was not found on PATH.`) };
      }
    }
    return { kind: "unconfigured", reason: setupReason(`Unknown ORACLE_CHAT_BACKEND value: ${requested}`) };
  }

  if (remote) return { kind: "remote", config: remote };
  if (standalone) return { kind: "standalone", config: standalone };
  if (hermes?.ok) return { kind: "hermes", bin: hermes.bin };
  return { kind: "unconfigured", reason: setupReason() };
}

export default { resolveChatBackend, standaloneConfigFromEnv, detectInstalledHarnesses };
