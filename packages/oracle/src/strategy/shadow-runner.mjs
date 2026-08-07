// Durable shadow strategy runner. Intent tracking only: no network, keys, or broadcast.

import { createHash } from "node:crypto";
import { compileStrategy } from "./compiler.mjs";
import { openShadowStore } from "./shadow-store.mjs";

function deepClone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function orderId(runnerId, strategyHash, signalBarT, side) {
  return createHash("sha256")
    .update(`${runnerId}|${strategyHash}|${signalBarT}|${side}`)
    .digest("hex");
}

function runnerIdFor(clockMs, strategyHash) {
  return createHash("sha256").update(`shadow|${clockMs}|${strategyHash}`).digest("hex");
}

function sideForAction(action) {
  if (action === "entryLong" || action === "exitShort") return "buy";
  if (action === "entryShort" || action === "exitLong") return "sell";
  return action;
}

function isEntry(action) {
  return action === "entryLong" || action === "entryShort";
}

function isExit(action) {
  return action === "exitLong" || action === "exitShort";
}

/**
 * @param {{storePath: string, clock?: () => number}} opts
 */
export function createShadowRunner({ storePath, clock = Date.now } = {}) {
  if (typeof storePath !== "string" || !storePath) {
    throw new Error("shadow-runner: storePath required");
  }
  const store = openShadowStore({ path: storePath });

  function start({ strategy, evidenceId = null } = {}) {
    const compiled = compileStrategy(strategy);
    const now = clock();
    const id = runnerIdFor(now, compiled.strategyHash);
    const existing = store.get(id);
    if (existing) {
      return deepClone(existing);
    }
    const record = {
      id,
      strategy: deepClone(compiled.strategy),
      strategyHash: compiled.strategyHash,
      compilerHash: compiled.compilerHash,
      evidenceId: evidenceId == null ? null : String(evidenceId),
      status: "running",
      cursor: null,
      intendedOrders: [],
      fills: [],
      missedFills: [],
      markouts: [],
      createdAt: now,
      updatedAt: now,
      // Internal paper state (persisted for restart continuity)
      position: null,
      cooldownUntilBarIndex: null,
      lastProcessedBarIndex: -1,
    };
    return store.create(record);
  }

  function get(id) {
    return store.get(id);
  }

  function list() {
    return store.list();
  }

  function stop(id) {
    return store.stop(id);
  }

  function step(id, bars, { markoutHorizons = [1, 4, 12] } = {}) {
    if (!Array.isArray(bars)) throw new TypeError("shadow-runner: bars must be an array");
    return store.update(id, (rec) => {
      if (rec.status !== "running") {
        throw new Error("shadow-runner: runner is stopped");
      }
      if (bars.length === 0) {
        rec.updatedAt = clock();
        return rec;
      }

      const compiled = compileStrategy(rec.strategy);
      const evaluated = compiled.evaluateAll(bars);

      // Map bar t -> index for this batch
      const indexByT = new Map();
      for (let i = 0; i < bars.length; i++) indexByT.set(bars[i].t, i);

      // Only process closed bars with t > cursor
      const cursor = rec.cursor;
      const processIndexes = [];
      for (let i = 0; i < bars.length; i++) {
        const t = bars[i].t;
        if (cursor == null || t > cursor) processIndexes.push(i);
      }

      const orderById = new Map(rec.intendedOrders.map((o) => [o.id, o]));
      const fillOrderIds = new Set(rec.fills.map((f) => f.orderId));
      const missedByOrderId = new Map(rec.missedFills.map((m) => [m.orderId, m]));
      const markoutKey = (orderId, horizon) => `${orderId}|${horizon}`;
      const markoutByKey = new Map(rec.markouts.map((m) => [markoutKey(m.orderId, m.horizon), m]));

      let position = rec.position ? { ...rec.position } : null;
      let cooldownUntilBarIndex =
        rec.cooldownUntilBarIndex == null ? null : rec.cooldownUntilBarIndex;

      // Helper: ensure intended order exists once
      function ensureOrder({ action, signalBarT, signalIndex }) {
        const side = sideForAction(action);
        const oid = orderId(rec.id, rec.strategyHash, signalBarT, side);
        if (orderById.has(oid)) return orderById.get(oid);
        const fillIndex = signalIndex + 1;
        const hasNext = fillIndex < bars.length;
        const order = {
          id: oid,
          action,
          type: action,
          side,
          signalBarT,
          fillBarT: hasNext ? bars[fillIndex].t : null,
          status: hasNext ? "open" : "missed",
        };
        orderById.set(oid, order);
        rec.intendedOrders.push(order);
        return order;
      }

      function recordFill(order, fillBar, fillIndex) {
        if (fillOrderIds.has(order.id)) return;
        const fill = {
          orderId: order.id,
          action: isEntry(order.action) ? "entry" : "exit",
          side: order.side,
          price: fillBar.o,
          barT: fillBar.t,
          signalBarT: order.signalBarT,
          barIndex: fillIndex,
        };
        rec.fills.push(fill);
        fillOrderIds.add(order.id);
        order.status = "filled";
        order.fillBarT = fillBar.t;
        // Clear missed if reconciling
        if (missedByOrderId.has(order.id)) {
          missedByOrderId.delete(order.id);
          rec.missedFills = rec.missedFills.filter((m) => m.orderId !== order.id);
        }
        if (isEntry(order.action)) {
          position = {
            side: order.action === "entryLong" ? "long" : "short",
            entryOrderId: order.id,
            entryBarT: fillBar.t,
            entryPrice: fillBar.o,
            entryBarIndex: fillIndex,
          };
          // Seed pending markouts
          for (const horizon of markoutHorizons) {
            const key = markoutKey(order.id, horizon);
            if (markoutByKey.has(key)) continue;
            const m = {
              orderId: order.id,
              horizon,
              entryBarT: fillBar.t,
              entryPrice: fillBar.o,
              side: position.side,
              status: "pending",
              close: null,
              barT: null,
            };
            markoutByKey.set(key, m);
            rec.markouts.push(m);
          }
        } else {
          position = null;
          const cd = Number(rec.strategy?.risk?.cooldownBars) || 0;
          cooldownUntilBarIndex = fillIndex + cd;
        }
      }

      function recordMissed(order) {
        if (fillOrderIds.has(order.id)) return;
        if (missedByOrderId.has(order.id)) return;
        const m = {
          orderId: order.id,
          action: order.action,
          side: order.side,
          signalBarT: order.signalBarT,
          status: "missed",
        };
        missedByOrderId.set(order.id, m);
        rec.missedFills.push(m);
        order.status = "missed";
      }

      // First: try to reconcile previously missed fills if next bar now exists
      for (const order of rec.intendedOrders) {
        if (order.status === "filled" || fillOrderIds.has(order.id)) continue;
        const sigIdx = indexByT.get(order.signalBarT);
        if (sigIdx == null) continue;
        const fillIndex = sigIdx + 1;
        if (fillIndex < bars.length) {
          // Only fill if that fill bar is in the processable set or already at/before new bars
          recordFill(order, bars[fillIndex], fillIndex);
        }
      }

      // Process signals on closed bars in order
      for (const i of processIndexes) {
        const bar = bars[i];
        const signals = evaluated[i].signals;

        // Cooldown: cannot enter until bar index > cooldownUntilBarIndex
        const inCooldown =
          cooldownUntilBarIndex != null && i <= cooldownUntilBarIndex;

        const tryEntry = (action) => {
          if (position) return;
          if (inCooldown) return;
          const order = ensureOrder({ action, signalBarT: bar.t, signalIndex: i });
          const fillIndex = i + 1;
          if (fillIndex < bars.length) {
            // Fill happens on next bar; if next bar is also being processed later, fill now
            recordFill(order, bars[fillIndex], fillIndex);
          } else {
            recordMissed(order);
          }
        };

        const tryExit = (action) => {
          if (!position) return;
          if (position.side === "long" && action !== "exitLong") return;
          if (position.side === "short" && action !== "exitShort") return;
          const order = ensureOrder({ action, signalBarT: bar.t, signalIndex: i });
          const fillIndex = i + 1;
          if (fillIndex < bars.length) {
            recordFill(order, bars[fillIndex], fillIndex);
          } else {
            recordMissed(order);
          }
        };

        // Exits first on the signal bar, then entries (still one position max)
        if (signals.exitLong) tryExit("exitLong");
        if (signals.exitShort) tryExit("exitShort");
        if (signals.entryLong) tryEntry("entryLong");
        if (signals.entryShort) tryEntry("entryShort");

        rec.cursor = bar.t;
        rec.lastProcessedBarIndex = i;
      }

      // Resolve markouts against available future closes (exactly once)
      for (const m of rec.markouts) {
        if (m.status !== "pending") continue;
        const entryFill = rec.fills.find((f) => f.orderId === m.orderId && f.action === "entry");
        if (!entryFill) continue;
        // Find fill bar index in current bars by t
        const fillIdx = indexByT.get(entryFill.barT);
        if (fillIdx == null) continue;
        const targetIdx = fillIdx + m.horizon;
        if (targetIdx < bars.length) {
          m.close = bars[targetIdx].c;
          m.barT = bars[targetIdx].t;
          m.status = "filled";
          // markout value: long (close-entry)/entry; short (entry-close)/entry
          const entry = m.entryPrice;
          m.markout =
            m.side === "long" ? (m.close - entry) / entry : (entry - m.close) / entry;
        }
      }

      rec.position = position;
      rec.cooldownUntilBarIndex = cooldownUntilBarIndex;
      rec.updatedAt = clock();
      return rec;
    });
  }

  return { start, step, list, get, stop };
}
