import { spawn } from "node:child_process";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function spawnChild(command, args = [], options = {}, label = command) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let settled = false;
    let forwardedSignal = null;

    const handlers = new Map(
      FORWARDED_SIGNALS.map((signal) => [signal, () => {
        forwardedSignal ||= signal;
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      }]),
    );
    for (const [signal, handler] of handlers) process.on(signal, handler);

    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stderr.write(`oracle: could not start ${label}: ${error.message}\n`);
      resolve(1);
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const propagated = forwardedSignal || signal;
      if (propagated) {
        process.kill(process.pid, propagated);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
