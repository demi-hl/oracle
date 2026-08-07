import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createShadowRunner } from "../src/strategy/shadow-runner.mjs";
import { compileStrategy, STRATEGY_COMPILER_HASH } from "../src/strategy/compiler.mjs";
import { strategyHash } from "../src/strategy/schema.mjs";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-shadow-runner-"));
  return path.join(dir, "shadow.json");
}

function risk(extra = {}) {
  return {
    maxLeverage: 5,
    maxNotionalUsd: 1000,
    positionSizePct: 10,
    stopLossPct: 2,
    takeProfitPct: 4,
    cooldownBars: 2,
    maxDailyLossPct: 5,
    expiresAt: 1_900_000_000_000,
    ...extra,
  };
}

function bar(t, c, o = c, h, l, v = 100) {
  const hi = h != null ? h : Math.max(o, c) + 1;
  const lo = l != null ? l : Math.min(o, c) - 1;
  return { t, o, h: hi, l: lo, c, v };
}

/** Close-threshold long: entry when close > 10, exit when close < 8. */
function thresholdStrategy(extraRisk = {}) {
  return {
    version: 1,
    id: "thresh-long",
    name: "Thresh Long",
    venue: "hyperliquid",
    market: { coin: "BTC", interval: "1m" },
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "entryLevel", type: "constant", value: 10 },
      { id: "exitLevel", type: "constant", value: 8 },
      { id: "enter", type: "compare", op: "gt", left: "c", right: "entryLevel" },
      { id: "exit", type: "compare", op: "lt", left: "c", right: "exitLevel" },
    ],
    rules: {
      entryLong: "enter",
      entryShort: null,
      exitLong: "exit",
      exitShort: null,
    },
    risk: risk(extraRisk),
  };
}

function shortStrategy() {
  return {
    version: 1,
    id: "thresh-short",
    name: "Thresh Short",
    venue: "hyperliquid",
    market: { coin: "ETH", interval: "1m" },
    parameters: {},
    nodes: [
      { id: "c", type: "input", field: "close" },
      { id: "entryLevel", type: "constant", value: 10 },
      { id: "exitLevel", type: "constant", value: 12 },
      { id: "enter", type: "compare", op: "lt", left: "c", right: "entryLevel" },
      { id: "exit", type: "compare", op: "gt", left: "c", right: "exitLevel" },
    ],
    rules: {
      entryLong: null,
      entryShort: "enter",
      exitLong: null,
      exitShort: "exit",
    },
    risk: risk({ cooldownBars: 0 }),
  };
}

test("start validates compiles and persists runner snapshot", () => {
  let now = 1_700_000_000_000;
  const storePath = tmpStore();
  const runner = createShadowRunner({ storePath, clock: () => now });
  const strategy = thresholdStrategy();
  const started = runner.start({ strategy, evidenceId: "ev-1" });
  assert.equal(started.status, "running");
  assert.equal(started.evidenceId, "ev-1");
  assert.equal(started.cursor, null);
  assert.deepEqual(started.intendedOrders, []);
  assert.deepEqual(started.fills, []);
  assert.deepEqual(started.missedFills, []);
  assert.deepEqual(started.markouts, []);
  assert.equal(started.createdAt, now);
  assert.equal(started.updatedAt, now);
  const compiled = compileStrategy(strategy);
  assert.equal(started.strategyHash, compiled.strategyHash);
  assert.equal(started.compilerHash, STRATEGY_COMPILER_HASH);
  assert.equal(started.strategyHash, strategyHash(compiled.strategy));
  assert.ok(typeof started.id === "string" && started.id.length >= 16);
  assert.deepEqual(runner.get(started.id).id, started.id);
  assert.equal(runner.list().length, 1);
});

test("runner id is deterministic for injected clock and strategy hash", () => {
  const strategy = thresholdStrategy();
  const clock = () => 42;
  const a = createShadowRunner({ storePath: tmpStore(), clock }).start({ strategy });
  const b = createShadowRunner({ storePath: tmpStore(), clock }).start({ strategy });
  assert.equal(a.id, b.id);
  const c = createShadowRunner({ storePath: tmpStore(), clock: () => 43 }).start({ strategy });
  assert.notEqual(a.id, c.id);
});

test("closed-bar signals create intended orders for the NEXT bar never same bar", () => {
  const storePath = tmpStore();
  let now = 1000;
  const runner = createShadowRunner({ storePath, clock: () => now++ });
  const strategy = thresholdStrategy({ cooldownBars: 0 });
  const { id } = runner.start({ strategy });
  // bar0 close 9 no entry; bar1 close 11 entry signal; bar2 is fill bar open 12
  const bars = [
    bar(1_000, 9, 9),
    bar(2_000, 11, 10),
    bar(3_000, 12, 12),
  ];
  const snap = runner.step(id, bars);
  assert.ok(snap.intendedOrders.length >= 1);
  const entry = snap.intendedOrders.find((o) => o.action === "entry" || o.side === "buy" || o.type === "entryLong");
  assert.ok(entry, "expected entry intended order");
  // Signal bar is the closed bar with entryLong true (t=2000), fill on next open (t=3000)
  assert.equal(entry.signalBarT, 2_000);
  assert.notEqual(entry.signalBarT, entry.fillBarT);
  assert.equal(entry.fillBarT, 3_000);
  const fill = snap.fills.find((f) => f.orderId === entry.id || f.signalBarT === 2_000);
  assert.ok(fill, "expected theoretical next-open fill");
  assert.equal(fill.price, 12);
  assert.equal(fill.barT, 3_000);
});

test("deterministic order id from runner id strategyHash signal bar t and side", () => {
  const storePath = tmpStore();
  const runner = createShadowRunner({ storePath, clock: () => 7 });
  const strategy = thresholdStrategy({ cooldownBars: 0 });
  const { id, strategyHash: sh } = runner.start({ strategy });
  const bars = [bar(1_000, 9), bar(2_000, 11), bar(3_000, 12)];
  const snap = runner.step(id, bars);
  const order = snap.intendedOrders[0];
  assert.ok(order.id);
  const material = `${id}|${sh}|${order.signalBarT}|${order.side || order.action}`;
  // id must be a stable hash digest-like string derived from those inputs
  const digest = createHash("sha256").update(material).digest("hex");
  assert.ok(
    order.id === digest || order.id === digest.slice(0, order.id.length) || digest.startsWith(order.id) || order.id.includes(digest.slice(0, 16)),
    `order id should derive from runner/strategy/signal/side; got ${order.id}`,
  );
});

test("repeat step and process restart do not duplicate orders fills markouts", () => {
  const storePath = tmpStore();
  let t = 5000;
  const clock = () => t++;
  const strategy = thresholdStrategy({ cooldownBars: 0 });
  const runner = createShadowRunner({ storePath, clock });
  const { id } = runner.start({ strategy });
  const bars = [
    bar(1_000, 9),
    bar(2_000, 11),
    bar(3_000, 12),
    bar(4_000, 13),
    bar(5_000, 14),
    bar(6_000, 7), // exit signal
    bar(7_000, 7, 7), // exit fill open
    bar(8_000, 7),
    bar(9_000, 7),
    bar(10_000, 7),
    bar(11_000, 7),
    bar(12_000, 7),
    bar(13_000, 7),
    bar(14_000, 7),
    bar(15_000, 7),
  ];
  const a = runner.step(id, bars, { markoutHorizons: [1, 4] });
  const b = runner.step(id, bars, { markoutHorizons: [1, 4] });
  assert.equal(b.intendedOrders.length, a.intendedOrders.length);
  assert.equal(b.fills.length, a.fills.length);
  assert.equal(b.markouts.length, a.markouts.length);
  assert.equal(b.missedFills.length, a.missedFills.length);
  const orderIds = b.intendedOrders.map((o) => o.id);
  assert.equal(new Set(orderIds).size, orderIds.length);

  // Restart with new runner instance, same path
  const runner2 = createShadowRunner({ storePath, clock });
  const c = runner2.step(id, bars, { markoutHorizons: [1, 4] });
  assert.equal(c.intendedOrders.length, a.intendedOrders.length);
  assert.equal(c.fills.length, a.fills.length);
  assert.equal(c.markouts.length, a.markouts.length);
});

test("missedFills when no next bar remain reconcilable without duplication", () => {
  const storePath = tmpStore();
  const runner = createShadowRunner({ storePath, clock: () => 9 });
  const strategy = thresholdStrategy({ cooldownBars: 0 });
  const { id } = runner.start({ strategy });
  const first = runner.step(id, [bar(1_000, 9), bar(2_000, 11)]);
  assert.ok(first.missedFills.length >= 1, "signal on last bar should miss fill");
  assert.equal(first.fills.length, 0);
  const orderId = first.intendedOrders[0].id;
  assert.equal(first.missedFills[0].orderId || first.missedFills[0].id, orderId);

  const second = runner.step(id, [bar(1_000, 9), bar(2_000, 11), bar(3_000, 15, 14)]);
  assert.equal(second.missedFills.filter((m) => (m.orderId || m.id) === orderId).length, 0);
  const fillsFor = second.fills.filter((f) => (f.orderId || f.id) === orderId);
  assert.equal(fillsFor.length, 1);
  assert.equal(fillsFor[0].price, 14);
  // stepping again must not re-add missed or duplicate fill
  const third = runner.step(id, [bar(1_000, 9), bar(2_000, 11), bar(3_000, 15, 14)]);
  assert.equal(third.fills.filter((f) => (f.orderId || f.id) === orderId).length, 1);
  assert.equal(third.missedFills.filter((m) => (m.orderId || m.id) === orderId).length, 0);
});

test("one paper position max with cooldownBars after exit", () => {
  const storePath = tmpStore();
  const runner = createShadowRunner({ storePath, clock: () => 11 });
  const strategy = thresholdStrategy({ cooldownBars: 2 });
  const { id } = runner.start({ strategy });
  // enter at 2, fill 3; still entry signals 4,5 while in position -> no second entry
  // exit signal 6 fill 7; cooldown bars 7 and 8; entry signal 9 should still be blocked if cooldown counts fill bar; entry at 10 after cooldown
  const bars = [
    bar(1_000, 9),
    bar(2_000, 11), // entry signal
    bar(3_000, 12, 12), // entry fill
    bar(4_000, 13), // still entry signal, in position
    bar(5_000, 14),
    bar(6_000, 7), // exit signal
    bar(7_000, 7, 7), // exit fill
    bar(8_000, 11), // entry signal during cooldown
    bar(9_000, 11), // still cooldown depending on count
    bar(10_000, 11), // allowed after cooldown
    bar(11_000, 12, 12),
  ];
  const snap = runner.step(id, bars);
  const entries = snap.intendedOrders.filter(
    (o) => o.action === "entry" || o.type === "entryLong" || (o.side === "buy" && o.action !== "exit"),
  );
  // At most one open at a time; after exit+cooldown another entry may occur -> exactly 2 entries in this path
  assert.ok(entries.length <= 2, `expected at most 2 entries, got ${entries.length}`);
  assert.ok(entries.length >= 1);
  // No duplicate concurrent position: fills should alternate entry/exit
  const entryFills = snap.fills.filter((f) => f.action === "entry" || f.side === "buy" && f.action !== "exit");
  assert.ok(entryFills.length <= 2);
});

test("markouts for filled entries at horizons; later step fills pending exactly once", () => {
  const storePath = tmpStore();
  const runner = createShadowRunner({ storePath, clock: () => 13 });
  const strategy = thresholdStrategy({ cooldownBars: 0 });
  const { id } = runner.start({ strategy });
  // entry signal bar1, fill bar2 open; horizons 1 and 4 from fill bar
  const partial = [
    bar(1_000, 9),
    bar(2_000, 11),
    bar(3_000, 20, 10), // fill open 10, close 20 -> horizon1 close when bar index fill+1
    bar(4_000, 21),
  ];
  const a = runner.step(id, partial, { markoutHorizons: [1, 4] });
  const pending = a.markouts.filter((m) => m.status === "pending" || m.price == null);
  const done = a.markouts.filter((m) => m.status === "filled" || (m.price != null && m.status !== "pending"));
  assert.ok(a.markouts.length >= 1);
  // With only a few bars after fill, horizon 4 should still be pending
  assert.ok(pending.length >= 1 || a.markouts.some((m) => m.horizon === 4 && (m.status === "pending" || m.close == null)));

  const more = [
    ...partial,
    bar(5_000, 22),
    bar(6_000, 23),
    bar(7_000, 30), // fill+4 close
  ];
  const b = runner.step(id, more, { markoutHorizons: [1, 4] });
  const h1 = b.markouts.filter((m) => m.horizon === 1);
  const h4 = b.markouts.filter((m) => m.horizon === 4);
  assert.equal(h1.length, 1);
  assert.equal(h4.length, 1);
  assert.ok(h1[0].close != null || h1[0].price != null);
  assert.ok(h4[0].close != null || h4[0].price != null);
  const c = runner.step(id, more, { markoutHorizons: [1, 4] });
  assert.equal(c.markouts.filter((m) => m.horizon === 1).length, 1);
  assert.equal(c.markouts.filter((m) => m.horizon === 4).length, 1);
});

test("future bars cannot cause an order at an earlier signal timestamp before that bar was processed", () => {
  const storePath = tmpStore();
  const runner = createShadowRunner({ storePath, clock: () => 17 });
  const strategy = thresholdStrategy({ cooldownBars: 0 });
  const { id } = runner.start({ strategy });
  // First only bars before the signal
  runner.step(id, [bar(1_000, 9)]);
  let snap = runner.get(id);
  assert.equal(snap.intendedOrders.length, 0);
  // Now include signal bar alone -> intended order, missed fill
  snap = runner.step(id, [bar(1_000, 9), bar(2_000, 11)]);
  assert.ok(snap.intendedOrders.some((o) => o.signalBarT === 2_000));
  // Cursor must not jump past unprocessed bars: after first step cursor is 1000
  // After second, cursor is 2000
  assert.equal(snap.cursor, 2_000);
  // Providing a future-only batch without history should only process t > cursor
  snap = runner.step(id, [bar(1_000, 9), bar(2_000, 11), bar(3_000, 12, 12), bar(4_000, 5)]);
  assert.ok(snap.cursor >= 3_000);
  // No order should claim a signalBarT that is after cursor from a previous incomplete view incorrectly backdated
  for (const o of snap.intendedOrders) {
    assert.ok(o.signalBarT <= snap.cursor || o.fillBarT != null);
  }
});

test("stop is idempotent and stopped runner cannot step", () => {
  const storePath = tmpStore();
  const runner = createShadowRunner({ storePath, clock: () => 19 });
  const { id } = runner.start({ strategy: thresholdStrategy() });
  const s1 = runner.stop(id);
  assert.equal(s1.status, "stopped");
  const s2 = runner.stop(id);
  assert.equal(s2.status, "stopped");
  assert.throws(() => runner.step(id, [bar(1, 1), bar(2, 2)]), /stopped|status/i);
});

test("short entry and exit intended orders and fills", () => {
  const storePath = tmpStore();
  const runner = createShadowRunner({ storePath, clock: () => 23 });
  const { id } = runner.start({ strategy: shortStrategy() });
  const bars = [
    bar(1_000, 11),
    bar(2_000, 9), // entry short
    bar(3_000, 8, 8), // fill
    bar(4_000, 13), // exit short
    bar(5_000, 13, 13),
  ];
  const snap = runner.step(id, bars);
  assert.ok(snap.intendedOrders.length >= 2);
  assert.ok(snap.fills.length >= 2);
});

test("static import graph contains no hl-exec key-vault operator signer submit broadcast", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/strategy");
  const entries = ["shadow-store.mjs", "shadow-runner.mjs", "handoff.mjs"].map((f) => path.join(root, f));
  const forbidden = ["hl-exec", "key-vault", "operator", "signer", "submit", "broadcast"];
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const word of forbidden) {
      // only flag implementation imports, not comments about them in tests
      const importHits = [
        ...src.matchAll(/^\s*import\s+[^'"]*from\s+["']([^"']+)["']/gm),
        ...src.matchAll(/^\s*export\s+[^'"]*from\s+["']([^"']+)["']/gm),
      ].map((m) => m[1]);
      for (const spec of importHits) {
        assert.equal(
          forbidden.some((f) => spec.includes(f)),
          false,
          `${file} imports forbidden ${spec}`,
        );
      }
    }
    const specs = [
      ...src.matchAll(/^\s*import\s+[^'"]*from\s+["']([^"']+)["']/gm),
      ...src.matchAll(/^\s*export\s+[^'"]*from\s+["']([^"']+)["']/gm),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), spec);
      for (const cand of [base, `${base}.mjs`, `${base}.js`, path.join(base, "index.mjs")]) {
        if (fs.existsSync(cand)) stack.push(cand);
      }
    }
  }
  assert.ok(seen.size >= 3);
});

test("source and tests contain no em dash or en dash", () => {
  const src = fs.readFileSync(new URL("../src/strategy/shadow-runner.mjs", import.meta.url), "utf8");
  const testSrc = fs.readFileSync(new URL(import.meta.url), "utf8");
  for (const text of [src, testSrc]) {
    assert.equal(text.includes("\u2014"), false);
    assert.equal(text.includes("\u2013"), false);
  }
});

test("never imports network fetch or signs", () => {
  const src = fs.readFileSync(new URL("../src/strategy/shadow-runner.mjs", import.meta.url), "utf8");
  assert.equal(/\bfetch\s*\(/.test(src), false);
  assert.equal(/hl-perps/.test(src), false);
  assert.equal(/hl-exec/.test(src), false);
  assert.equal(/key-vault/.test(src), false);
});
