import { spawnChild } from "../spawn-child.mjs";
import { resolveHermes } from "../runtime.mjs";
import { readModelConfig, writeModelConfig } from "../model-config.mjs";
import { oracleHarnessInvocation } from "./chat.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

function standalonePatch(args) {
  const backend = option(args, "--backend");
  const provider = option(args, "--provider");
  const model = option(args, "--model") || option(args, "-m");
  const baseUrl = option(args, "--base-url");
  const apiKeyEnv = option(args, "--api-key-env");
  const contextLength = option(args, "--context-length");
  const reasoningEffort = option(args, "--reasoning-effort");
  const computeHost = option(args, "--compute-host") || option(args, "--remote-host");
  const computeUser = option(args, "--compute-user") || option(args, "--remote-user");
  const computePath = option(args, "--compute-path") || option(args, "--remote-path");
  const hasStandaloneField = Boolean(provider || model || baseUrl || apiKeyEnv || contextLength || reasoningEffort || computeHost || computeUser || computePath);
  if (!backend && !hasStandaloneField) return null;
  const current = { ...(readModelConfig() || {}) };
  if (provider) {
    delete current.apiKeyEnv;
    if (provider !== "custom" || provider !== current.provider) delete current.baseUrl;
  }
  return {
    ...current,
    backend: backend || "standalone",
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(contextLength ? { contextLength } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(computeHost ? { computeHost } : {}),
    ...(computeUser ? { computeUser } : {}),
    ...(computePath ? { computePath } : {}),
  };
}

function usage() {
  return [
    "oracle model, choose standalone model settings or open Hermes' picker",
    "",
    "  oracle model",
    "  oracle model --show",
    "  oracle model --backend standalone --provider openrouter --model openrouter/auto",
    "  oracle model --backend remote --compute-host <host>",
    "  oracle model --backend auto",
    "",
    "standalone keys stay in environment variables, never model.json:",
    "  OPENROUTER_API_KEY, OPENAI_API_KEY, XAI_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY",
  ].join("\n");
}

export default {
  name: "model",
  summary: "choose Oracle's standalone model or existing Hermes provider",
  group: "read",
  usage: usage(),
  async run(ctx) {
    const args = [...ctx.argv];
    if (args.includes("--show")) {
      process.stdout.write(`${JSON.stringify(readModelConfig() || { backend: "auto" }, null, 2)}\n`);
      return 0;
    }

    const patch = standalonePatch(args);
    if (patch) {
      try {
        const saved = writeModelConfig(patch);
        process.stdout.write(`oracle model: ${saved.backend}`);
        if (saved.provider) process.stdout.write(` / ${saved.provider}`);
        if (saved.model) process.stdout.write(` / ${saved.model}`);
        process.stdout.write("\n");
        if (saved.backend === "standalone" && saved.apiKeyEnv) {
          process.stdout.write(`key source: ${saved.apiKeyEnv}\n`);
        }
        return 0;
      } catch (error) {
        process.stderr.write(`oracle model: ${error.message}\n`);
        return 1;
      }
    }

    const found = resolveHermes();
    if (!found.ok) {
      process.stderr.write(
        "Oracle standalone chat does not require Hermes.\n" +
          "Configure a provider with: oracle model --backend standalone --provider openrouter --model openrouter/auto\n" +
          "Then set OPENROUTER_API_KEY.\n",
      );
      return 1;
    }
    const launch = oracleHarnessInvocation(found.bin, ["-p", "oracle", "model", ...args]);
    return spawnChild(
      launch.command,
      launch.args,
      { stdio: "inherit", env: process.env },
      "oracle-model",
    );
  },
};
