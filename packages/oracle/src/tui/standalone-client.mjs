import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";

import { PACKAGE_ROOT } from "../cli/paths.mjs";
import { getMemoryBlock, addMemory, removeMemory, MEMORY_TOOLS } from "./memory.mjs";
import { getSkillsBlock, loadSkill, createSkill, listSkills, SKILL_TOOLS } from "./skills-loader.mjs";
import { createScheduler, listJobs, addJob, removeJob, CRON_TOOLS } from "./scheduler.mjs";
import { recordTurn, analyzeForSkill, META_TOOLS } from "./meta-learn.mjs";
import { envEnabled } from "../oracle-env.mjs";

const ALLOWED_COMMANDS = new Set(["chain", "data", "scan", "route", "prepare"]);
const ALLOWED_CHAIN = new Set(["list", "show"]);
const ALLOWED_DATA = new Set(["call", "catalog", "health"]);
const ALLOWED_ROUTE = new Set(["swap", "bridge", "prepare", "prepare-bridge"]);
const OAUTH_BASE_URLS = Object.freeze({
  "anthropic-oauth": "https://api.anthropic.com/v1",
  "openai-codex": "https://chatgpt.com/backend-api/codex",
  "xai-oauth": "https://api.x.ai/v1",
});
const MAX_TOOL_OUTPUT = 20_000;
const MAX_AGENT_STEPS = 6;

const ORACLE_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "oracle_cli",
    description: "Run a bounded read or prepare-only Oracle CLI command. It cannot sign or broadcast transactions.",
    parameters: {
      type: "object",
      properties: {
        argv: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 24,
          description: "Arguments after the oracle executable, for example [\"scan\",\"chains\"] or [\"data\",\"health\"].",
        },
      },
      required: ["argv"],
      additionalProperties: false,
    },
  },
});

/** All tools available to the standalone agent. */
const ALL_TOOLS = Object.freeze([
  ORACLE_TOOL,
  ...MEMORY_TOOLS,
  ...SKILL_TOOLS,
  ...CRON_TOOLS,
  ...META_TOOLS,
]);

function trimOutput(value) {
  const text = String(value || "");
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n[truncated ${text.length - MAX_TOOL_OUTPUT} chars]`;
}

async function dispatchTool(name, parsed, toolRunner) {
  switch (name) {
    case "oracle_cli":
      return toolRunner(parsed.argv);
    case "memory_add":
      addMemory(parsed.key, parsed.content);
      return { ok: true, stored: parsed.key };
    case "memory_remove":
      return removeMemory(parsed.key);
    case "skill_load": {
      const content = loadSkill(parsed.name);
      return content ? { ok: true, name: parsed.name, content } : { ok: false, error: `skill not found: ${parsed.name}` };
    }
    case "skill_create":
      createSkill(parsed.name, parsed.content);
      return { ok: true, created: parsed.name };
    case "skill_list": {
      const skills = listSkills();
      return { ok: true, skills: skills.map((s) => ({ name: s.name, description: s.description })) };
    }
    case "cron_add": {
      const job = addJob({ name: parsed.name, schedule: parsed.schedule, prompt: parsed.prompt, skills: parsed.skills || [], enabled: true });
      return { ok: true, job };
    }
    case "cron_list":
      return { ok: true, jobs: listJobs() };
    case "cron_remove":
      return { ok: removeJob(parsed.id), removed: parsed.id };
    case "meta_analyze": {
      const suggestion = analyzeForSkill();
      return { ok: true, ...(suggestion || { shouldCreate: false, suggestion: "No skill suggestions yet." }) };
    }
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

function validateCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 24) {
    return "argv must contain 1 to 24 arguments";
  }
  if (argv.some((arg) => typeof arg !== "string" || arg.length > 1_000)) {
    return "every argument must be a string no longer than 1000 characters";
  }
  const command = argv[0];
  if (!ALLOWED_COMMANDS.has(command)) return `command not allowed: ${command}`;
  if (command === "chain" && !ALLOWED_CHAIN.has(argv[1] || "list")) {
    return `command not allowed: chain${argv[1] ? ` ${argv[1]}` : ""}`;
  }
  if (command === "data" && !ALLOWED_DATA.has(argv[1] || "")) {
    return `command not allowed: data${argv[1] ? ` ${argv[1]}` : ""}`;
  }
  if (command === "route" && !ALLOWED_ROUTE.has(argv[1] || "")) {
    return `command not allowed: route${argv[1] ? ` ${argv[1]}` : ""}`;
  }
  return null;
}

export async function runOracleCommand(argv, options = {}) {
  const invalid = validateCommand(argv);
  if (invalid) return { ok: false, error: invalid };
  const spawnFn = options.spawnFn || spawnSync;
  const root = options.packageRoot || PACKAGE_ROOT;
  const result = spawnFn(
    process.execPath,
    [path.join(root, "bin", "oracle.mjs"), ...argv],
    {
      encoding: "utf8",
      timeout: options.timeoutMs || 45_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ORACLE_CHAT_TOOL: "1" },
    },
  );
  if (result.error) return { ok: false, error: result.error.message };
  return {
    ok: result.status === 0,
    status: typeof result.status === "number" ? result.status : 1,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
  };
}

function defaultPersona() {
  const file = path.join(PACKAGE_ROOT, "profiles", "oracle", "SOUL.md");
  const soul = fs.readFileSync(file, "utf8");
  const memory = getMemoryBlock();
  const skills = getSkillsBlock();
  const blocks = [soul.trim()];
  if (memory) blocks.push(memory);
  blocks.push(skills);
  blocks.push(
    "You have tools for Oracle CLI commands, durable memory, skills, cron scheduling, and meta-learning.",
    "Use memory_add to persist facts. Use skill_create to save successful workflows. Use cron_add to schedule recurring tasks.",
  );
  return blocks.join("\n\n");
}

function eventFrame(type, sessionId, payload = {}) {
  return {
    method: "event",
    params: {
      type,
      session_id: sessionId,
      payload,
    },
  };
}

async function responseError(response) {
  return new Error(`model request failed (HTTP ${response?.status || "unknown"})`);
}

async function* parseSse(response) {
  if (!response?.ok) throw await responseError(response);
  if (!response.body) throw new Error("model response had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      yield JSON.parse(data);
    }
    if (done) break;
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const data = tail.slice(5).trim();
    if (data && data !== "[DONE]") yield JSON.parse(data);
  }
}

function mergeToolDelta(map, delta) {
  const index = Number(delta.index || 0);
  const current = map.get(index) || {
    id: "",
    type: "function",
    function: { name: "", arguments: "" },
  };
  if (delta.id) current.id += delta.id;
  if (delta.type) current.type = delta.type;
  if (delta.function?.name) current.function.name += delta.function.name;
  if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
  map.set(index, current);
}

function usagePayload(usage, contextLength) {
  const input = Number(usage?.prompt_tokens || usage?.input_tokens || 0);
  const output = Number(usage?.completion_tokens || usage?.output_tokens || 0);
  return {
    context_used: input,
    context_max: contextLength,
    context_percent: contextLength > 0 ? Math.round((input / contextLength) * 100) : 0,
    input,
    output,
  };
}

function allResponseTools() {
  return ALL_TOOLS.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    strict: false,
  }));
}

function allAnthropicTools() {
  return ALL_TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function appendAnthropicMessage(output, role, blocks) {
  const normalized = Array.isArray(blocks) ? blocks : [{ type: "text", text: String(blocks || "") }];
  const previous = output.at(-1);
  if (previous?.role === role) previous.content.push(...normalized);
  else output.push({ role, content: normalized });
}

function toAnthropicMessages(messages) {
  const output = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      appendAnthropicMessage(output, "user", [{ type: "text", text: String(message.content || "") }]);
      continue;
    }
    if (message.role === "assistant") {
      const blocks = [];
      if (message.content) blocks.push({ type: "text", text: String(message.content) });
      for (const call of message.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || "{}"); } catch {}
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function?.name,
          input,
        });
      }
      if (blocks.length) appendAnthropicMessage(output, "assistant", blocks);
      continue;
    }
    if (message.role === "tool") {
      appendAnthropicMessage(output, "user", [{
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: String(message.content || ""),
      }]);
    }
  }
  return output;
}

function toResponsesInput(messages) {
  const output = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      output.push({ role: "user", content: [{ type: "input_text", text: String(message.content || "") }] });
      continue;
    }
    if (message.role === "assistant") {
      if (message.content) {
        output.push({
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: String(message.content) }],
        });
      }
      for (const call of message.tool_calls || []) {
        output.push({
          type: "function_call",
          id: call.response_item_id || undefined,
          call_id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments || "{}",
        });
      }
      continue;
    }
    if (message.role === "tool") {
      output.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: String(message.content || ""),
      });
    }
  }
  return output.map((item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)));
}

function accountIdFromJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return String(payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || "");
  } catch {
    return "";
  }
}

async function chatCompletionStep({ config, messages, fetchFn, signal, onText }) {
  const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...(config.provider === "openrouter" ? {
        "HTTP-Referer": "https://oracle-agent.dev",
        "X-Title": "Oracle CLI",
      } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: ALL_TOOLS,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });
  const toolDeltas = new Map();
  let text = "";
  let usage = null;
  for await (const frame of parseSse(response)) {
    if (frame.usage) usage = frame.usage;
    const delta = frame.choices?.[0]?.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const toolDelta of delta.tool_calls || []) mergeToolDelta(toolDeltas, toolDelta);
  }
  return {
    text,
    usage,
    toolCalls: [...toolDeltas.entries()].sort(([a], [b]) => a - b).map(([, value]) => value),
  };
}

async function anthropicStep({ config, messages, persona, credential, fetchFn, signal, onText }) {
  const response = await fetchFn(`${config.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      Authorization: `Bearer ${credential.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,claude-code-20250219,oauth-2025-04-20",
      "user-agent": `claude-code/${process.env.ORACLE_CLAUDE_CODE_VERSION || "2.1.220"} (external, cli)`,
      "x-app": "cli",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: Number(config.maxOutputTokens || 8192),
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        { type: "text", text: persona },
      ],
      messages: toAnthropicMessages(messages),
      tools: allAnthropicTools(),
      tool_choice: { type: "auto" },
      stream: true,
    }),
    signal,
  });
  const toolCalls = new Map();
  let text = "";
  let usage = null;
  for await (const frame of parseSse(response)) {
    if (frame.type === "message_start") usage = { ...(usage || {}), ...(frame.message?.usage || {}) };
    if (frame.type === "message_delta") usage = { ...(usage || {}), ...(frame.usage || {}) };
    if (frame.type === "content_block_start" && frame.content_block?.type === "tool_use") {
      const block = frame.content_block;
      toolCalls.set(Number(frame.index || 0), {
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : "",
        },
      });
    }
    if (frame.type === "content_block_delta" && frame.delta?.type === "text_delta") {
      text += frame.delta.text || "";
      if (frame.delta.text) onText(frame.delta.text);
    }
    if (frame.type === "content_block_delta" && frame.delta?.type === "input_json_delta") {
      const index = Number(frame.index || 0);
      const call = toolCalls.get(index);
      if (call) call.function.arguments += frame.delta.partial_json || "";
    }
    if (frame.type === "error") throw new Error(frame.error?.message || "Claude stream failed");
  }
  return {
    text,
    usage,
    toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => {
      if (!value.function.arguments) value.function.arguments = "{}";
      return value;
    }),
  };
}

async function responsesStep({ config, messages, persona, sessionId, credential, fetchFn, signal, onText }) {
  const isCodex = config.provider === "openai-codex";
  const accountId = isCodex ? accountIdFromJwt(credential.accessToken) : "";
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    Authorization: `Bearer ${credential.accessToken}`,
    ...(isCodex ? {
      "user-agent": "codex_cli_rs/0.0.0 (Oracle CLI)",
      originator: "codex_cli_rs",
      ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
      session_id: sessionId,
      "x-client-request-id": sessionId,
    } : {
      "x-grok-conv-id": sessionId,
    }),
  };
  const body = {
    model: config.model,
    instructions: persona,
    input: toResponsesInput(messages),
    tools: allResponseTools(),
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    ...(isCodex ? { reasoning: { effort: config.reasoningEffort || "high", summary: "auto" } } : {}),
  };
  const response = await fetchFn(`${config.baseUrl}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const toolCalls = new Map();
  let text = "";
  let usage = null;
  for await (const frame of parseSse(response)) {
    if (frame.type === "response.output_text.delta" && typeof frame.delta === "string") {
      text += frame.delta;
      onText(frame.delta);
    }
    const item = frame.item;
    if ((frame.type === "response.output_item.added" || frame.type === "response.output_item.done") && item?.type === "function_call") {
      const key = String(item.call_id || item.id || frame.output_index || toolCalls.size);
      toolCalls.set(key, {
        id: item.call_id || item.id,
        response_item_id: item.id,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" },
      });
    }
    if (frame.type === "response.function_call_arguments.delta") {
      const key = String(frame.call_id || frame.item_id || frame.output_index || "");
      const call = toolCalls.get(key);
      if (call) call.function.arguments += frame.delta || "";
    }
    if (frame.type === "response.completed") usage = frame.response?.usage || usage;
    if (frame.type === "response.failed" || frame.type === "error") {
      throw new Error(frame.response?.error?.message || frame.error?.message || "Responses stream failed");
    }
  }
  return { text, usage, toolCalls: [...toolCalls.values()] };
}

export function createStandaloneClient(options = {}) {
  const config = options.config;
  if (!config?.baseUrl || !config?.model) throw new Error("standalone model configuration is incomplete");
  if (config.authType === "oauth") {
    const expected = OAUTH_BASE_URLS[config.provider];
    const actual = String(config.baseUrl).replace(/\/+$/, "");
    if (!expected || actual !== expected) throw new Error(`${config.provider || "unknown"} OAuth endpoint is not trusted`);
  }
  const emitter = new EventEmitter();
  const fetchFn = options.fetchFn || globalThis.fetch;
  const toolRunner = options.toolRunner || ((argv) => runOracleCommand(argv, options));
  const credentialProvider = options.credentialProvider || (async (provider) => {
    const { resolveOAuthCredentials } = await import("../auth/oauth.mjs");
    return resolveOAuthCredentials(provider);
  });
  const persona = options.persona || defaultPersona();
  const sessionId = options.sessionId || `oracle-${randomUUID()}`;
  let history = [];
  let controller = null;
  let stopped = false;
  let active = false;

  const scheduler = createScheduler(async (prompt, skills) => {
    if (stopped) return;
    const skillBlocks = (skills || []).map((name) => {
      const content = loadSkill(name);
      return content ? `## Skill: ${name}\n${content}` : null;
    }).filter(Boolean);
    const skillContext = skillBlocks.length > 0 ? `\n\n${skillBlocks.join("\n\n")}` : "";
    await performTurn(`${prompt}${skillContext}`);
  });
  if (envEnabled("ORACLE_CRON_ENABLED", "MAD_CRON_ENABLED", true)) {
    scheduler.on("run", (evt) => emitEvent("cron.run", evt));
    scheduler.on("complete", (evt) => emitEvent("cron.complete", evt));
    scheduler.on("error", (evt) => emitEvent("cron.error", evt));
    scheduler.start();
  }

  function emitEvent(type, payload = {}) {
    emitter.emit("event", eventFrame(type, sessionId, payload));
  }

  function emitError(error) {
    emitEvent("error", { message: error?.message || String(error) });
    if (emitter.listenerCount("error") > 0) emitter.emit("error", error);
  }

  async function performTurn(text) {
    active = true;
    controller = new AbortController();
    const messages = [
      { role: "system", content: persona },
      ...history,
      { role: "user", content: text },
    ];
    let finalText = "";
    let usage = null;
    let messageStarted = false;

    try {
      for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
        const credential = config.authType === "oauth"
          ? await credentialProvider(config.provider)
          : null;
        const onText = (delta) => {
          if (!messageStarted) {
            emitEvent("message.start", {});
            messageStarted = true;
          }
          finalText += delta;
          emitEvent("message.delta", { text: delta });
        };
        const request = {
          config,
          messages,
          persona,
          sessionId,
          credential,
          fetchFn,
          signal: controller.signal,
          onText,
        };
        const result = config.protocol === "anthropic-messages"
          ? await anthropicStep(request)
          : config.protocol === "responses"
            ? await responsesStep(request)
            : await chatCompletionStep(request);
        const stepText = result.text;
        const toolCalls = result.toolCalls;
        usage = result.usage || usage;

        if (toolCalls.length === 0) {
          messages.push({ role: "assistant", content: stepText });
          history = messages.slice(1);
          if (!messageStarted) emitEvent("message.start", {});
          emitEvent("message.complete", {
            text: finalText,
            usage: usagePayload(usage, config.contextLength),
          });
          return;
        }

        messages.push({ role: "assistant", content: stepText || null, tool_calls: toolCalls });
        let toolCallCount = toolCalls.length;
        let toolErrors = 0;
        for (const call of toolCalls) {
          let result;
          try {
            const parsed = JSON.parse(call.function.arguments || "{}");
            result = await dispatchTool(call.function.name, parsed, toolRunner);
          } catch (error) {
            result = { ok: false, error: `invalid tool arguments: ${error.message}` };
            toolErrors++;
          }
          if (!result.ok) toolErrors++;
          messages.push({
            role: "tool",
            tool_call_id: call.id || `call_${randomUUID()}`,
            content: JSON.stringify(result),
          });
        }
        recordTurn({
          userMessage: text,
          toolCalls: toolCallCount,
          errors: toolErrors,
          recovered: toolErrors > 0 ? Boolean(toolCalls.length) : false,
          durationMs: 0,
        });
      }
      throw new Error(`agent exceeded ${MAX_AGENT_STEPS} tool steps`);
    } catch (error) {
      if (error?.name !== "AbortError") emitError(error);
    } finally {
      active = false;
      controller = null;
    }
  }

  async function start() {
    if (stopped) throw new Error("standalone client is stopped");
  }

  async function request(method, params = {}) {
    if (stopped) throw new Error("standalone client is stopped");
    if (method === "session.create") {
      emitEvent("session.info", {
        model: params.model || config.model,
        reasoning_effort: config.reasoningEffort,
        usage: { context_max: config.contextLength },
        backend: "standalone",
      });
      return {
        session_id: sessionId,
        info: {
          model: params.model || config.model,
          reasoning_effort: config.reasoningEffort,
          usage: { context_max: config.contextLength },
          backend: "standalone",
        },
      };
    }
    if (method === "prompt.submit") {
      if (active) throw new Error("a turn is already active");
      const text = String(params.text || "").trim();
      if (!text) throw new Error("prompt text is required");
      queueMicrotask(() => { performTurn(text).catch(emitError); });
      return { accepted: true };
    }
    if (method === "session.interrupt") {
      const interrupted = Boolean(controller && active);
      controller?.abort();
      return { interrupted };
    }
    if (method === "session.usage") {
      return { calls: 0, input: 0, output: 0, total: 0 };
    }
    throw new Error(`unsupported standalone method: ${method}`);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    controller?.abort();
    scheduler.stop();
  }

  return Object.freeze({
    start,
    request,
    stop,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  });
}

export async function runStandaloneQuery({
  client,
  text,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  if (!client) throw new Error("standalone client is required");
  await client.start();
  const session = await client.request("session.create", { source: "cli" });
  let written = "";
  let settled = false;

  try {
    return await new Promise((resolve, reject) => {
      const handle = (frame) => {
        const type = frame?.params?.type;
        const payload = frame?.params?.payload || {};
        if (type === "message.delta" && typeof payload.text === "string") {
          written += payload.text;
          stdout.write(payload.text);
          return;
        }
        if (type === "message.complete") {
          if (!written && payload.text) stdout.write(String(payload.text));
          stdout.write("\n");
          settled = true;
          resolve(0);
          return;
        }
        if (type === "error") {
          const message = payload.message || payload.text || "standalone chat failed";
          stderr.write(`oracle chat: ${message}\n`);
          settled = true;
          reject(new Error(message));
        }
      };
      client.on("event", handle);
      client.request("prompt.submit", {
        session_id: session.session_id,
        text,
      }).catch((error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  } finally {
    await client.stop();
  }
}

export default { createStandaloneClient, runOracleCommand, runStandaloneQuery };
