import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPalette,
  fg,
  hexToRgb,
  stripAnsi,
} from "../src/tui/theme.mjs";
import {
  compactTokens,
  contextBar,
  padTo,
  renderBanner,
  renderBox,
  renderStatusBar,
  visibleWidth,
} from "../src/tui/format.mjs";

const plain = createPalette({ color: false });

test("hexToRgb parses six digit colors", () => {
  assert.deepEqual(hexToRgb("#B8F0FF"), { r: 184, g: 240, b: 255 });
});

test("hexToRgb parses shorthand without a hash", () => {
  assert.deepEqual(hexToRgb("0fA"), { r: 0, g: 255, b: 170 });
});

test("hexToRgb rejects garbage", () => {
  assert.equal(hexToRgb("not-a-color"), null);
  assert.equal(hexToRgb("#1234"), null);
});

test("a disabled palette returns unescaped text", () => {
  assert.equal(plain.fg("#ffffff", "hello"), "hello");
  assert.equal(plain.bg("#000000", "hello"), "hello");
  assert.equal(plain.bold("hello"), "hello");
  assert.equal(plain.dim("hello"), "hello");
});

test("stripAnsi recovers colored text", () => {
  assert.equal(stripAnsi(fg("#B8F0FF", "oracle")), "oracle");
});

test("visibleWidth ignores ANSI and counts block glyphs", () => {
  assert.equal(visibleWidth(fg("#B8F0FF", "█░box")), 5);
});

test("padTo aligns left", () => {
  assert.equal(padTo("hi", 5, "left"), "hi   ");
});

test("padTo aligns right", () => {
  assert.equal(padTo("hi", 5, "right"), "   hi");
});

test("padTo aligns center", () => {
  assert.equal(padTo("hi", 5, "center"), " hi  ");
});

test("padTo truncates to visible width", () => {
  assert.equal(padTo("oracle", 3), "ora");
  assert.equal(visibleWidth(padTo(fg("#B8F0FF", "oracle"), 3)), 3);
});

test("compactTokens formats its boundaries", () => {
  assert.equal(compactTokens(999), "999");
  assert.equal(compactTokens(1000), "1K");
  assert.equal(compactTokens(1_000_000), "1M");
  assert.equal(compactTokens(1_500_000), "1.5M");
});

test("contextBar clamps low values", () => {
  assert.equal(contextBar(0, 4), "░░░░");
  assert.equal(contextBar(-5, 4), "░░░░");
});

test("contextBar clamps high values", () => {
  assert.equal(contextBar(100, 4), "████");
  assert.equal(contextBar(150, 4), "████");
});

test("renderStatusBar always has the requested visible width", () => {
  for (const width of [20, 40, 80, 200]) {
    const result = renderStatusBar({
      model: "gpt-5",
      contextTokens: 12_000,
      contextLength: 200_000,
      percent: 6,
      effort: "high",
      thinking: "thinking",
      chain: "ethereum",
      width,
      palette: createPalette(),
    });
    assert.equal(visibleWidth(result), width);
  }
});

test("renderBanner selects narrow and wide layouts", () => {
  const narrow = renderBanner({ width: 40, palette: plain });
  const wide = renderBanner({ width: 80, palette: plain });
  assert.equal(narrow.length, 2);
  assert.equal(stripAnsi(narrow[0]).trim(), "oracle");
  assert.equal(wide.length, 12);
  assert.ok(stripAnsi(wide[0]).includes("╭"));
  assert.ok(stripAnsi(wide.at(-1)).includes("╯"));
  assert.ok(wide.some((line) => /████/.test(line)));
  assert.ok(wide.every((line) => visibleWidth(line) === 80));
});

test("renderBanner centers wordmark ink on the screen axis", () => {
  for (const width of [80, 100, 120, 177, 200]) {
    const lines = renderBanner({ width, palette: plain }).map((line) => stripAnsi(line));
    const art = lines.filter((line) => /[█░]/.test(line));
    assert.ok(art.length === 6, `expected six art rows at ${width}`);

    let left = Infinity;
    let right = Infinity;
    for (const row of art) {
      const first = row.search(/[█░]/);
      const last = row.length - 1 - [...row].reverse().join("").search(/[█░]/);
      left = Math.min(left, first);
      right = Math.min(right, width - 1 - last);
    }
    // Ink bounding box must sit within half a cell of the true screen centre.
    assert.ok(Math.abs(left - right) <= 1, `wordmark off-centre at ${width}: ${left}/${right}`);
  }
});

test("renderBanner centers the tagline on the screen axis", () => {
  for (const width of [80, 100, 120, 177, 200]) {
    const lines = renderBanner({ width, palette: plain }).map((line) => stripAnsi(line));
    const row = lines.find((line) => line.includes("THE FUTURE IS AGENTIC"));
    assert.ok(row, `tagline missing at ${width}`);
    const start = row.indexOf("THE FUTURE");
    const end = start + "THE FUTURE IS AGENTIC  /  by DEMI".length - 1;
    const centre = (start + end) / 2;
    const axis = (width - 1) / 2;
    assert.ok(
      Math.abs(centre - axis) <= 0.5,
      `tagline off-centre at ${width}: centre ${centre} vs axis ${axis}`,
    );
  }
});

test("renderBox uses matching corners and exact widths", () => {
  const box = renderBox({ lines: ["hello", "world"], width: 20, palette: plain, title: "input" });
  assert.ok(box[0].startsWith("╭") && box[0].endsWith("╮"));
  assert.ok(box.at(-1).startsWith("╰") && box.at(-1).endsWith("╯"));
  assert.ok(box.every((line) => visibleWidth(line) === 20));
});
