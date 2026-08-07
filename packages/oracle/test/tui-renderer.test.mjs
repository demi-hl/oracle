import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRenderer } from "../src/tui/renderer.mjs";

const HIDE = "\u001b[?25l";
const SHOW = "\u001b[?25h";
const CLEAR = "\u001b[2K";
const ERASE_DOWN = "\u001b[0J";

function fakeStdout(options = {}) {
  return {
    writes: [],
    rows: options.rows,
    columns: options.columns,
    write(s) {
      this.writes.push(s);
      return true;
    },
  };
}

function fakeResizeStdout({ rows = 24, columns = 80 } = {}) {
  const stream = new EventEmitter();
  stream.writes = [];
  stream.rows = rows;
  stream.columns = columns;
  stream.write = function write(s) {
    this.writes.push(s);
    return true;
  };
  return stream;
}

function bytes(stream) {
  return stream.writes.join("");
}

test("first render emits the requested lines", () => {
  const stdout = fakeStdout({ rows: 24, columns: 80 });
  const renderer = createRenderer({ stdout });

  renderer.render(["prompt", "status"]);

  const out = bytes(stdout);
  assert.ok(out.startsWith(HIDE));
  assert.ok(out.endsWith(SHOW));
  assert.match(out, /prompt/);
  assert.match(out, /status/);
  assert.doesNotMatch(out, /\u001b\[\?1049h/);
});

test("identical second render emits zero bytes", () => {
  const stdout = fakeStdout({ rows: 24, columns: 80 });
  const renderer = createRenderer({ stdout });

  renderer.render(["prompt", "status"]);
  stdout.writes = [];
  renderer.render(["prompt", "status"]);

  assert.equal(bytes(stdout), "");
});

test("changing one line of three only rewrites that line", () => {
  const stdout = fakeStdout({ rows: 24, columns: 80 });
  const renderer = createRenderer({ stdout });

  renderer.render(["top", "middle", "bottom"]);
  stdout.writes = [];
  renderer.render(["top", "changed", "bottom"]);

  const out = bytes(stdout);
  assert.match(out, /changed/);
  assert.doesNotMatch(out, /top/);
  assert.doesNotMatch(out, /bottom/);
});

test("growing the rendered line count appends new lines", () => {
  const stdout = fakeStdout({ rows: 24, columns: 80 });
  const renderer = createRenderer({ stdout });

  renderer.render(["one"]);
  stdout.writes = [];
  renderer.render(["one", "two", "three"]);

  const out = bytes(stdout);
  assert.doesNotMatch(out, /one/);
  assert.match(out, /two/);
  assert.match(out, /three/);
});

test("shrinking the rendered line count erases the removed region", () => {
  const stdout = fakeStdout({ rows: 24, columns: 80 });
  const renderer = createRenderer({ stdout });

  renderer.render(["one", "two", "three"]);
  stdout.writes = [];
  renderer.render(["one"]);

  const out = bytes(stdout);
  assert.match(out, new RegExp(ERASE_DOWN.replace("[", "\\[")));
  assert.doesNotMatch(out, /two/);
  assert.doesNotMatch(out, /three/);
});

test("long ANSI line truncates by visible width without cutting escape codes", () => {
  const stdout = fakeStdout({ rows: 24, columns: 5 });
  const renderer = createRenderer({ stdout });

  renderer.render(["\u001b[31mabcdef\u001b[0m"]);

  const out = bytes(stdout);
  assert.match(out, /\u001b\[31mabcde\u001b\[0m/);
  assert.doesNotMatch(out, /abcdef/);
  assert.doesNotMatch(out, /\u001b\[31mabcde\u001b\[0m\u001b\[0m/);
});

test("short ANSI styled line remains intact", () => {
  const stdout = fakeStdout({ rows: 24, columns: 20 });
  const renderer = createRenderer({ stdout });
  const line = "\u001b[32mok\u001b[0m";

  renderer.render([line]);

  assert.ok(bytes(stdout).includes(line));
});

test("writeAbove writes content before repainting the fixed region", () => {
  const stdout = fakeStdout({ rows: 24, columns: 80 });
  const renderer = createRenderer({ stdout });

  renderer.render(["prompt", "status"]);
  stdout.writes = [];
  renderer.writeAbove("assistant output");

  const out = bytes(stdout);
  assert.ok(out.indexOf("assistant output") < out.indexOf("prompt"));
  assert.ok(out.indexOf("prompt") < out.indexOf("status"));
  assert.match(out, /\u001b\[1A/);
});

test("clear resets state so the next render paints every line", () => {
  const stdout = fakeStdout({ rows: 24, columns: 80 });
  const renderer = createRenderer({ stdout });

  renderer.render(["one", "two"]);
  stdout.writes = [];
  renderer.clear();
  assert.match(bytes(stdout), new RegExp(ERASE_DOWN.replace("[", "\\[")));

  stdout.writes = [];
  renderer.render(["one", "two"]);

  const out = bytes(stdout);
  assert.match(out, /one/);
  assert.match(out, /two/);
});

test("cursor is hidden while painting and shown after", () => {
  const stdout = fakeStdout({ rows: 24, columns: 80 });
  const renderer = createRenderer({ stdout });

  renderer.render(["line"]);

  const out = bytes(stdout);
  assert.ok(out.startsWith(HIDE));
  assert.ok(out.endsWith(SHOW));
});

test("dispose shows the cursor and is idempotent", () => {
  const stdout = fakeStdout({ rows: 24, columns: 80 });
  const renderer = createRenderer({ stdout });

  renderer.dispose();
  renderer.dispose();

  assert.deepEqual(stdout.writes, [SHOW]);
});

test("size falls back to twenty four rows and eighty columns", () => {
  const stdout = fakeStdout();
  const renderer = createRenderer({ stdout });

  assert.deepEqual(renderer.getSize(), { rows: 24, columns: 80 });
});

test("resize event updates getSize", () => {
  const stdout = fakeResizeStdout({ rows: 10, columns: 20 });
  const renderer = createRenderer({ stdout });

  stdout.rows = 30;
  stdout.columns = 100;
  stdout.emit("resize");

  assert.deepEqual(renderer.getSize(), { rows: 30, columns: 100 });
});

test("setLines fixes the rendered region height", () => {
  const stdout = fakeStdout({ rows: 24, columns: 80 });
  const renderer = createRenderer({ stdout });

  renderer.setLines(2);
  renderer.render(["only"]);

  const out = bytes(stdout);
  assert.match(out, /only/);
  assert.ok(out.includes(`${CLEAR}only\n\r${CLEAR}`));
});
