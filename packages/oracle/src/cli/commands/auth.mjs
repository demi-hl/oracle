import { writeModelConfig } from "../model-config.mjs";
import {
  getOAuthStore,
  loginOAuth,
  oauthProviderConfig,
  oauthProviderId,
} from "../../auth/oauth.mjs";

const API_PROVIDERS = Object.freeze({
  openrouter: { model: "openrouter/auto" },
  openai: { model: "gpt-4.1-mini" },
  xai: { model: "grok-4.5" },
  deepseek: { model: "deepseek-chat" },
  gemini: { model: "gemini-2.5-flash" },
  custom: { model: "" },
});

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : "";
}

async function readAllStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

function readHidden(prompt = "API key: ") {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("non-interactive API-key input requires --stdin");
  }
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      const text = String(chunk);
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new Error("cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function selection(provider, model, { baseUrl = "" } = {}) {
  if (!model) throw new Error(`${provider} provider requires --model`);
  const config = { backend: "standalone", provider, model };
  if (provider === "custom") {
    if (!baseUrl) throw new Error("custom provider requires --base-url");
    config.baseUrl = baseUrl;
  }
  return config;
}

function saveSelection(provider, model, options = {}) {
  return writeModelConfig(selection(provider, model, options));
}

function printStatus(status) {
  process.stdout.write(`storage: ${status.storage}\n`);
  const oauth = Object.entries(status.providers || {});
  const apiKeys = Object.entries(status.apiKeys || {});
  if (!oauth.length && !apiKeys.length) {
    process.stdout.write("no credentials configured\n");
    return;
  }
  for (const [provider, value] of oauth) {
    const expiry = value.expiresAt ? new Date(value.expiresAt).toISOString() : "unknown";
    process.stdout.write(`${provider}: ${value.loggedIn ? "logged in" : "missing"}, expires ${expiry}\n`);
  }
  for (const [provider, value] of apiKeys) {
    process.stdout.write(`${provider}: API key ${value.configured ? "configured" : "missing"}\n`);
  }
}

function usage() {
  return [
    "oracle auth, configure OAuth or API-key authentication",
    "",
    "  oracle auth login claude|codex|grok [--model MODEL] [--no-browser]",
    "  oracle auth api-key PROVIDER [--model MODEL] [--base-url URL]",
    "  printf '%s\\n' \"$KEY\" | oracle auth api-key PROVIDER --stdin",
    "  oracle auth status [--json]",
    "  oracle auth logout PROVIDER",
    "",
    "OAuth and API keys are additive. Select any compatible model with oracle model --provider PROVIDER --model MODEL.",
  ].join("\n");
}

export default {
  name: "auth",
  summary: "login with Claude, Codex, or Grok OAuth; store provider API keys",
  group: "read",
  usage: usage(),
  async run(ctx) {
    const args = [...ctx.argv];
    const action = args.shift() || "status";
    const store = getOAuthStore();
    try {
      if (action === "status") {
        const status = store.status();
        if (args.includes("--json")) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        else printStatus(status);
        return 0;
      }

      if (action === "login") {
        const requested = args.find((value) => !value.startsWith("-"));
        if (!requested) throw new Error("usage: oracle auth login claude|codex|grok");
        const config = oauthProviderConfig(requested);
        const model = option(args, "--model") || config.model;
        selection(config.id, model);
        const credential = await loginOAuth(config.id, {
          openFn: args.includes("--no-browser") ? () => false : undefined,
        });
        await store.withLock(async () => {
          const previous = store.get(config.id);
          store.set(config.id, credential);
          try {
            saveSelection(config.id, model);
          } catch (error) {
            if (previous) store.set(config.id, previous);
            else store.remove(config.id);
            throw error;
          }
        });
        process.stdout.write(`${config.id}: logged in, stored in ${store.storage}\n`);
        return 0;
      }

      if (action === "api-key") {
        const provider = String(args.find((value) => !value.startsWith("-")) || "").trim().toLowerCase();
        if (!provider) throw new Error("usage: oracle auth api-key PROVIDER [--stdin]");
        if (!Object.hasOwn(API_PROVIDERS, provider)) throw new Error(`unsupported API-key provider: ${provider}`);
        const model = option(args, "--model") || API_PROVIDERS[provider].model;
        const baseUrl = option(args, "--base-url");
        selection(provider, model, { baseUrl });
        const apiKey = args.includes("--stdin") ? await readAllStdin() : await readHidden();
        await store.withLock(async () => {
          const previous = store.getApiKey(provider);
          store.setApiKey(provider, apiKey);
          try {
            saveSelection(provider, model, { baseUrl });
          } catch (error) {
            if (previous) store.setApiKey(provider, previous);
            else store.removeApiKey(provider);
            throw error;
          }
        });
        process.stdout.write(`${provider}: API key configured in ${store.storage}\n`);
        return 0;
      }

      if (action === "logout") {
        const requested = String(args.find((value) => !value.startsWith("-")) || "").trim().toLowerCase();
        if (!requested) throw new Error("usage: oracle auth logout PROVIDER");
        let removedOAuth = false;
        try {
          removedOAuth = store.remove(oauthProviderId(requested));
        } catch {}
        const removedApiKey = store.removeApiKey(requested);
        if (!removedOAuth && !removedApiKey) throw new Error(`${requested}: no local credential found`);
        process.stdout.write(`${requested}: local credential removed\n`);
        return 0;
      }

      throw new Error(`unknown auth action: ${action}`);
    } catch (error) {
      process.stderr.write(`oracle auth: ${error.message}\n`);
      return 1;
    }
  },
};
