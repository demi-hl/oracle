import { EventEmitter } from "node:events";
import { activeChainEnv } from "../cli/chain-state.mjs";
import { createGatewayClient } from "./gateway-client.mjs";
import { createInput } from "./input.mjs";
import { createRenderer } from "./renderer.mjs";
import {
  formatElapsed,
  renderBanner,
  renderBox,
  renderStatusBar,
  visibleWidth,
  wrapText,
} from "./format.mjs";
import { createPalette, THEME } from "./theme.mjs";

const LIVE_TAIL_LINES = 6;

function parseChatArgs(args = []) {
  const out = { pass: [], query: null, model: null, provider: null, quiet: false, cont: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if ((a === "-q" || a === "--query") && args[i + 1]) {
      out.query = args[++i];
      out.pass.push("-q", out.query);
      continue;
    }
    if ((a === "--model" || a === "-m") && args[i + 1]) {
      out.model = args[++i];
      out.pass.push("--model", out.model);
      continue;
    }
    if (a === "--provider" && args[i + 1]) {
      out.provider = args[++i];
      out.pass.push("--provider", out.provider);
      continue;
    }
    if (a === "--quiet" || a === "-Q") {
      out.quiet = true;
      out.pass.push(a);
      continue;
    }
    if (a === "--continue" || a === "-c") {
      out.cont = true;
      out.pass.push("--continue");
      continue;
    }
    out.pass.push(a);
  }
  return out;
}

export function applyUsage(state, usage) {
  if (!usage || typeof usage !== "object") return;
  const used = Number(usage.context_used ?? usage.context_tokens ?? usage.input ?? usage.prompt);
  const max = Number(usage.context_max ?? usage.context_length);
  if (Number.isFinite(used) && used > 0) state.contextTokens = used;
  if (Number.isFinite(max) && max > 0) state.contextLength = max;
  const percent = Number(usage.context_percent);
  if (Number.isFinite(percent)) state.contextPercent = percent;
  else if (state.contextLength > 0) {
    state.contextPercent = Math.round((state.contextTokens / state.contextLength) * 100);
  }
}

export function composerLines(state) {
  const width = state.width;
  const label = `${state.promptLabel} `;
  const room = Math.max(1, width - 2 - visibleWidth(label));
  const buffer = state.buffer || "";
  const cursor = Math.max(0, Math.min(state.cursor ?? buffer.length, buffer.length));
  let start = 0;
  if (cursor > room) start = cursor - room;
  const view = buffer.slice(start, start + room);
  const rel = cursor - start;
  const head = view.slice(0, rel);
  const at = view.slice(rel, rel + 1) || " ";
  const tail = view.slice(rel + 1);
  const palette = state.palette;
  const painted = `${palette.fg(THEME.accent, label)}${head}${palette.bg(THEME.selection_bg, at)}${tail}`;
  return [painted];
}

export function fixedLines(state) {
  const width = state.width;
  const out = [];

  if (state.liveLines.length > 0) {
    for (const line of state.liveLines.slice(-LIVE_TAIL_LINES)) out.push(line);
    out.push("");
  }

  out.push(...renderBox({
    lines: composerLines(state),
    width,
    palette: state.palette,
    title: "Ask Oracle ›",
  }));

  out.push(renderStatusBar({
    model: state.model,
    contextTokens: state.contextTokens,
    contextLength: state.contextLength,
    percent: state.contextPercent,
    effort: state.effort,
    thinking: state.thinking,
    chain: state.chain,
    width,
    palette: state.palette,
  }));
  return out;
}

function eventShape(frame) {
  const params = frame?.params || frame || {};
  return {
    type: params.type || frame?.type || "",
    sessionId: params.session_id || frame?.session_id || "",
    payload: params.payload || frame?.payload || {},
  };
}

function textPayload(payload = {}) {
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.rendered === "string") return payload.rendered;
  if (typeof payload.message === "string") return payload.message;
  return "";
}

export function createOracleTui(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stdin = options.stdin || process.stdin;
  const width = Math.max(20, Number(stdout.columns || options.columns || 80));
  const palette = options.palette || createPalette({ color: stdout.isTTY !== false });
  const renderer = options.renderer || createRenderer({ stdout, rows: stdout.rows, columns: width });
  const client = options.client || createGatewayClient({
    python: options.python,
    pythonArgs: options.pythonArgs || [],
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    spawnFn: options.spawnFn,
    startupTimeoutMs: options.startupTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  const emitter = new EventEmitter();
  const now = options.now || (() => Date.now());
  const state = {
    palette,
    width,
    promptLabel: "oracle ›",
    buffer: "",
    cursor: 0,
    model: options.model || "model",
    contextTokens: 0,
    contextLength: 0,
    contextPercent: 0,
    effort: options.effort || "",
    thinking: "0s",
    chain: (options.env || process.env).ORACLE_ACTIVE_CHAIN || "",
    busy: false,
    cancelled: false,
    sessionId: null,
    assistantBuffer: "",
    flushedLines: 0,
    liveLines: [],
    startedAt: 0,
  };
  let input = null;
  let ticker = null;

  const ui = { renderer, state };

  function renderNow() {
    renderer.render(fixedLines(state));
  }

  function emitLine(text) {
    renderer.writeAbove(`${text}\n`);
  }

  function recomputeLive() {
    const parts = state.assistantBuffer.split("\n");
    const partial = parts[parts.length - 1] || "";
    state.liveLines = partial ? wrapText(partial, state.width) : [];
  }

  function flushAssistant({ final = false } = {}) {
    const parts = state.assistantBuffer.split("\n");
    const ready = final ? parts.length : parts.length - 1;
    let wrote = false;
    while (state.flushedLines < ready) {
      const line = parts[state.flushedLines];
      for (const wrapped of wrapText(line, state.width)) emitLine(wrapped);
      state.flushedLines += 1;
      wrote = true;
    }
    if (final) state.liveLines = [];
    else recomputeLive();
    return wrote;
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      if (!state.busy) return;
      state.thinking = formatElapsed(now() - state.startedAt);
      renderNow();
    }, 250);
    if (typeof ticker.unref === "function") ticker.unref();
  }

  function stopTicker() {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = null;
  }

  async function submit(text) {
    const value = String(text || "").trim();
    if (!value) return;
    if (value === "/exit" || value === "/quit") {
      await stop();
      return;
    }
    if (value === "/clear") {
      renderer.clear();
      for (const line of renderBanner({ width: state.width, palette })) emitLine(line);
      renderNow();
      return;
    }
    state.busy = true;
    state.assistantBuffer = "";
    state.flushedLines = 0;
    state.liveLines = [];
    state.startedAt = now();
    state.thinking = "0s";
    emitLine(`${palette.bold(palette.fg(THEME.prompt, "you"))}  ${value}`);
    emitLine("");
    startTicker();
    renderNow();
    await client.request("prompt.submit", { session_id: state.sessionId, text: value });
  }

  function handleEvent(frame) {
    const event = eventShape(frame);
    if (event.type === "gateway.ready") return;

    if (event.type === "session.info" && event.payload) {
      if (event.payload.model) state.model = event.payload.model;
      if (event.payload.reasoning_effort) state.effort = event.payload.reasoning_effort;
      applyUsage(state, event.payload.usage);
      renderNow();
      return;
    }
    if (event.type === "message.start") {
      state.busy = true;
      state.cancelled = false;
      state.assistantBuffer = "";
      state.flushedLines = 0;
      state.liveLines = [];
      emitLine(palette.bold(palette.fg(THEME.accent, "oracle")));
      renderNow();
      return;
    }
    if (event.type === "thinking.delta" || event.type === "reasoning.delta") {
      if (state.cancelled) return;
      const text = textPayload(event.payload).trim();
      if (text) state.thinking = `${formatElapsed(now() - state.startedAt)}`;
      renderNow();
      return;
    }
    if (event.type === "message.delta") {
      if (state.cancelled) return;
      state.assistantBuffer += textPayload(event.payload);
      flushAssistant();
      renderNow();
      return;
    }
    if (event.type === "message.complete") {
      if (state.cancelled) {
        state.cancelled = false;
        return;
      }
      const finalText = textPayload(event.payload);
      if (finalText && finalText.length >= state.assistantBuffer.length) {
        state.assistantBuffer = finalText;
      }
      flushAssistant({ final: true });
      emitLine("");
      state.busy = false;
      stopTicker();
      applyUsage(state, event.payload?.usage || event.payload?.context);
      state.thinking = formatElapsed(now() - state.startedAt);
      renderNow();
      return;
    }
    if (event.type === "error") {
      state.busy = false;
      stopTicker();
      emitLine(palette.fg(THEME.error, `error: ${textPayload(event.payload) || "unknown"}`));
      renderNow();
    }
  }

  async function start() {
    await client.start();
    client.on("event", handleEvent);
    client.on("log", (line) => emitter.emit("log", line));
    client.on("error", (error) => emitter.emit("error", error));
    const session = await client.request("session.create", {
      cols: state.width,
      cwd: options.cwd || process.cwd(),
      source: "cli",
      profile: options.profile || "oracle",
      close_on_disconnect: true,
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
    });
    state.sessionId = session.session_id;
    state.model = session.info?.model || state.model;
    if (session.info?.reasoning_effort) state.effort = session.info.reasoning_effort;
    applyUsage(state, session.info?.usage);
    for (const line of renderBanner({ width: state.width, palette })) emitLine(line);
    emitLine("");
    renderNow();
    input = createInput({
      stdin,
      stdout,
      onSubmit: (value) => { submit(value).catch((error) => emitter.emit("error", error)); },
      onCancel: () => {
        if (!state.busy) return;
        state.busy = false;
        state.cancelled = true;
        stopTicker();
        flushAssistant({ final: true });
        emitLine(palette.fg(THEME.warn, "interrupted"));
        emitLine("");
        renderNow();
        client.request("session.interrupt", { session_id: state.sessionId })
          .catch((error) => emitter.emit("error", error));
      },
      onEof: () => { stop().catch((error) => emitter.emit("error", error)); },
      onClear: () => {
        renderer.clear();
        renderNow();
      },
      onRender: (editorState) => {
        state.buffer = editorState.buffer || "";
        state.cursor = editorState.cursor ?? state.buffer.length;
        renderNow();
      },
    });
    input.start();
  }

  async function stop() {
    stopTicker();
    if (input) input.stop();
    renderer.dispose();
    await client.stop();
    emitter.emit("stop");
  }

  return Object.freeze({
    start,
    stop,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    state,
    handleEvent,
    submit,
  });
}

export async function runOracleTui({
  hermesPython,
  client,
  tuiFactory = createOracleTui,
  args = [],
  env = process.env,
  cwd = process.cwd(),
  stdout = process.stdout,
  stdin = process.stdin,
} = {}) {
  const parsed = parseChatArgs(args);
  if (parsed.query) return { native: false, pass: parsed.pass };
  if (!stdin.isTTY || !stdout.isTTY) return { native: false, pass: parsed.pass };
  if (env.ORACLE_NATIVE_TUI === "0") return { native: false, pass: parsed.pass };
  const invocation = hermesPython;
  if (!client && !invocation) return { native: false, pass: parsed.pass };
  const cleanEnv = activeChainEnv({
    ...env,
    ORACLE_CHAT_SURFACE: "1",
    ORACLE_PROFILE: "oracle",
    ORACLE_NODE_BIN: process.execPath,
  });
  const tui = tuiFactory({
    ...(client ? { client } : {}),
    ...(invocation ? {
      python: invocation.command,
      pythonArgs: invocation.prefix || [],
    } : {}),
    cwd,
    env: cleanEnv,
    stdin,
    stdout,
    model: parsed.model,
    provider: parsed.provider,
    profile: "oracle",
  });
  tui.on("log", (line) => {
    if (env.ORACLE_CLI_DEBUG) process.stderr.write(`${line}\n`);
  });
  tui.on("error", (error) => {
    process.stderr.write(`oracle chat: ${error.message}\n`);
  });
  await tui.start();
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      await tui.stop();
      resolve({ native: true, code: 0 });
    };
    tui.on("stop", () => {
      if (done) return;
      done = true;
      resolve({ native: true, code: 0 });
    });
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export default {
  createOracleTui,
  runOracleTui,
};
