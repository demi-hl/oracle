import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

function errorFromPayload(payload) {
  const message = typeof payload === "string"
    ? payload
    : payload?.message || "Gateway request failed";
  const error = new Error(message);
  error.error = payload;
  return error;
}

function truncateLog(line) {
  const bytes = Buffer.from(line);
  if (bytes.length <= 4096) return line;
  const removed = bytes.length - 4096;
  return `${bytes.subarray(0, 4096).toString("utf8")} ... [truncated ${removed} bytes]`;
}

export function createGatewayClient({
  python,
  pythonArgs = [],
  cwd,
  env,
  spawnFn = spawn,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const emitter = new EventEmitter();
  const pending = new Map();
  let child = null;
  let nextId = 1;
  let startPromise = null;
  let stopPromise = null;
  let exited = false;

  function emitError(error) {
    if (emitter.listenerCount("error") > 0) emitter.emit("error", error);
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function handleMessage(message) {
    if (!("id" in message)) {
      emitter.emit("event", message);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if ("error" in message) entry.reject(errorFromPayload(message.error));
    else entry.resolve(message.result);
  }

  function start() {
    if (startPromise) return startPromise;

    startPromise = new Promise((resolve, reject) => {
      let settled = false;
      let startupTimer;

      const finishStart = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        if (error) reject(error);
        else resolve();
      };

      try {
        child = spawnFn(python, [...pythonArgs, "-m", "tui_gateway.entry"], { cwd, env });
      } catch (error) {
        finishStart(error);
        emitError(error);
        return;
      }

      const stdout = createInterface({ input: child.stdout });
      const stderr = createInterface({ input: child.stderr });

      stdout.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          emitter.emit("log", line);
          return;
        }
        finishStart();
        handleMessage(message);
      });

      stderr.on("line", (line) => emitter.emit("log", truncateLog(line)));

      child.once("error", (error) => {
        finishStart(error);
        rejectPending(error);
        emitError(error);
      });

      child.once("exit", (code, signal) => {
        exited = true;
        const error = new Error(`Gateway exited with code ${code} and signal ${signal}`);
        finishStart(error);
        rejectPending(error);
        emitter.emit("exit", { code, signal });
      });

      startupTimer = setTimeout(() => {
        finishStart(new Error(`Gateway startup timed out after ${startupTimeoutMs} ms`));
      }, startupTimeoutMs);
    });

    return startPromise;
  }

  function request(method, params) {
    if (!child || exited) return Promise.reject(new Error("Gateway is not running"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Gateway request ${id} timed out after ${requestTimeoutMs} ms`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function stop() {
    if (stopPromise) return stopPromise;
    if (!child || exited) return Promise.resolve();

    const error = new Error("Gateway stopped while requests were pending");
    rejectPending(error);
    stopPromise = new Promise((resolve) => {
      child.once("exit", resolve);
      try {
        child.kill();
      } catch {
        resolve();
      }
    });
    return stopPromise;
  }

  return {
    start,
    request,
    stop,
    on(event, listener) {
      emitter.on(event, listener);
      return this;
    },
    off(event, listener) {
      emitter.off(event, listener);
      return this;
    },
  };
}
