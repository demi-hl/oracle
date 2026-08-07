import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  applyKey,
  createDecoder,
  createEditorState,
  createInput,
  decodeKeys,
} from "../src/tui/input.mjs";

const expectedKey = ({ name, ctrl = false, meta = false, shift = false, sequence }) => ({
  name,
  ctrl,
  meta,
  shift,
  sequence,
});

const firstKey = (sequence) => decodeKeys(sequence)[0];

const press = (state, sequence) => applyKey(state, firstKey(sequence)).state;

const typeText = (state, text) => {
  let next = state;
  for (const key of decodeKeys(text)) next = applyKey(next, key).state;
  return next;
};

const keyCases = [
  ["return cr", "\r", expectedKey({ name: "return", sequence: "\r" })],
  ["return lf", "\n", expectedKey({ name: "return", sequence: "\n" })],
  ["backspace del", "\u007f", expectedKey({ name: "backspace", sequence: "\u007f" })],
  ["backspace bs", "\b", expectedKey({ name: "backspace", sequence: "\b" })],
  ["tab", "\t", expectedKey({ name: "tab", sequence: "\t" })],
  ["escape", "\u001b", expectedKey({ name: "escape", sequence: "\u001b" })],
  ["ctrl a", "\x01", expectedKey({ name: "a", ctrl: true, sequence: "\x01" })],
  ["ctrl e", "\x05", expectedKey({ name: "e", ctrl: true, sequence: "\x05" })],
  ["ctrl u", "\x15", expectedKey({ name: "u", ctrl: true, sequence: "\x15" })],
  ["ctrl k", "\x0b", expectedKey({ name: "k", ctrl: true, sequence: "\x0b" })],
  ["ctrl w", "\x17", expectedKey({ name: "w", ctrl: true, sequence: "\x17" })],
  ["ctrl c", "\x03", expectedKey({ name: "c", ctrl: true, sequence: "\x03" })],
  ["ctrl d", "\x04", expectedKey({ name: "d", ctrl: true, sequence: "\x04" })],
  ["ctrl l", "\x0c", expectedKey({ name: "l", ctrl: true, sequence: "\x0c" })],
  ["up", "\u001b[A", expectedKey({ name: "up", sequence: "\u001b[A" })],
  ["down", "\u001b[B", expectedKey({ name: "down", sequence: "\u001b[B" })],
  ["right", "\u001b[C", expectedKey({ name: "right", sequence: "\u001b[C" })],
  ["left", "\u001b[D", expectedKey({ name: "left", sequence: "\u001b[D" })],
  ["home", "\u001b[H", expectedKey({ name: "home", sequence: "\u001b[H" })],
  ["end", "\u001b[F", expectedKey({ name: "end", sequence: "\u001b[F" })],
  ["delete", "\u001b[3~", expectedKey({ name: "delete", sequence: "\u001b[3~" })],
];

for (const [name, sequence, expected] of keyCases) {
  test(`decodeKeys decodes ${name}`, () => {
    assert.deepEqual(decodeKeys(sequence), [expected]);
  });
}

test("decodeKeys decodes printable ASCII and UTF-8", () => {
  assert.deepEqual(decodeKeys("aAé😀"), [
    expectedKey({ name: "a", sequence: "a" }),
    expectedKey({ name: "a", shift: true, sequence: "A" }),
    expectedKey({ name: "é", sequence: "é" }),
    expectedKey({ name: "😀", sequence: "😀" }),
  ]);
});

test("decodeKeys decodes multiple keys in one chunk", () => {
  assert.deepEqual(decodeKeys("ab\r"), [
    expectedKey({ name: "a", sequence: "a" }),
    expectedKey({ name: "b", sequence: "b" }),
    expectedKey({ name: "return", sequence: "\r" }),
  ]);
});

test("decodeKeys handles a CSI sequence split across two chunks", () => {
  assert.deepEqual(decodeKeys("\u001b["), []);
  assert.deepEqual(decodeKeys("A"), [expectedKey({ name: "up", sequence: "\u001b[A" })]);
});

test("decodeKeys handles a four byte emoji split across two chunks", () => {
  assert.deepEqual(decodeKeys(Buffer.from([0xf0, 0x9f])), []);
  assert.deepEqual(decodeKeys(Buffer.from([0x98, 0x80])), [
    expectedKey({ name: "😀", sequence: "😀" }),
  ]);
});

test("createDecoder handles a CSI sequence split across two chunks", () => {
  const decoder = createDecoder();
  assert.deepEqual(decoder.push("\u001b["), []);
  assert.deepEqual(decoder.push("A"), [expectedKey({ name: "up", sequence: "\u001b[A" })]);
});

test("createDecoder handles a four byte emoji split across two chunks", () => {
  const decoder = createDecoder();
  assert.deepEqual(decoder.push(Buffer.from([0xf0, 0x9f])), []);
  assert.deepEqual(decoder.push(Buffer.from([0x98, 0x80])), [
    expectedKey({ name: "😀", sequence: "😀" }),
  ]);
});

test("applyKey inserts, moves, and clamps the cursor", () => {
  let state = typeText(createEditorState(), "abc");
  assert.equal(state.buffer, "abc");
  assert.equal(state.cursor, 3);
  state = press(state, "\u001b[D");
  state = press(state, "\u001b[D");
  state = press(state, "X");
  assert.equal(state.buffer, "aXbc");
  assert.equal(state.cursor, 2);
  state = press(press(press(state, "\u001b[D"), "\u001b[D"), "\u001b[D");
  assert.equal(state.cursor, 0);
  state = press(press(press(press(press(state, "\u001b[C"), "\u001b[C"), "\u001b[C"), "\u001b[C"), "\u001b[C");
  assert.equal(state.cursor, 4);
});

test("applyKey supports ctrl a and ctrl e", () => {
  let state = typeText(createEditorState(), "abc");
  state = press(state, "\x01");
  assert.equal(state.cursor, 0);
  state = press(state, "\x05");
  assert.equal(state.cursor, 3);
});

test("applyKey supports home and end", () => {
  let state = typeText(createEditorState(), "abc");
  state = press(state, "\u001b[H");
  assert.equal(state.cursor, 0);
  state = press(state, "\u001b[F");
  assert.equal(state.cursor, 3);
});

test("applyKey supports ctrl u", () => {
  let state = typeText(createEditorState(), "abcdef");
  state = press(press(state, "\u001b[D"), "\u001b[D");
  state = press(state, "\x15");
  assert.equal(state.buffer, "ef");
  assert.equal(state.cursor, 0);
});

test("applyKey supports ctrl k", () => {
  let state = typeText(createEditorState(), "abcdef");
  state = press(press(state, "\u001b[D"), "\u001b[D");
  state = press(state, "\x0b");
  assert.equal(state.buffer, "abcd");
  assert.equal(state.cursor, 4);
});

test("applyKey supports ctrl w", () => {
  let state = typeText(createEditorState(), "one two three");
  state = press(state, "\x17");
  assert.equal(state.buffer, "one two ");
  assert.equal(state.cursor, 8);
});

test("applyKey ctrl w eats trailing spaces before the word", () => {
  let state = typeText(createEditorState(), "one two   ");
  state = press(state, "\x17");
  assert.equal(state.buffer, "one ");
  assert.equal(state.cursor, 4);
});

test("applyKey distinguishes backspace and delete", () => {
  let state = typeText(createEditorState(), "abcd");
  state = press(press(state, "\u001b[D"), "\u001b[D");
  state = press(state, "\u007f");
  assert.equal(state.buffer, "acd");
  assert.equal(state.cursor, 1);
  state = press(state, "\u001b[3~");
  assert.equal(state.buffer, "ad");
  assert.equal(state.cursor, 1);
});

test("applyKey submit trims and pushes history", () => {
  const before = typeText(createEditorState(), "  hello  ");
  const result = applyKey(before, firstKey("\r"));
  assert.deepEqual(result.action, { type: "submit", value: "hello" });
  assert.equal(result.state.buffer, "");
  assert.equal(result.state.cursor, 0);
  assert.deepEqual(result.state.history, ["hello"]);
});

test("applyKey empty submit is a no-op", () => {
  const before = createEditorState({ history: ["one"] });
  const result = applyKey(before, firstKey("\r"));
  assert.equal(result.action, null);
  assert.equal(result.state.buffer, "");
  assert.deepEqual(result.state.history, ["one"]);
});

test("applyKey walks history with draft stash and restore", () => {
  let state = createEditorState({ history: ["one", "two"] });
  state = typeText(state, "draft");
  state = press(state, "\u001b[A");
  assert.equal(state.buffer, "two");
  assert.equal(state.draft, "draft");
  state = press(state, "\u001b[A");
  assert.equal(state.buffer, "one");
  state = press(state, "\u001b[B");
  assert.equal(state.buffer, "two");
  state = press(state, "\u001b[B");
  assert.equal(state.buffer, "draft");
  assert.equal(state.draft, "");
  assert.equal(state.historyIndex, 2);
});

test("applyKey avoids duplicate consecutive history entries", () => {
  let state = typeText(createEditorState(), "same");
  state = applyKey(state, firstKey("\r")).state;
  state = typeText(state, " same ");
  const result = applyKey(state, firstKey("\r"));
  assert.deepEqual(result.state.history, ["same"]);
  assert.deepEqual(result.action, { type: "submit", value: "same" });
});

test("applyKey ctrl c cancels and clears", () => {
  const before = typeText(createEditorState(), "abc");
  const result = applyKey(before, firstKey("\x03"));
  assert.deepEqual(result.action, { type: "cancel" });
  assert.equal(result.state.buffer, "");
  assert.equal(result.state.cursor, 0);
});

test("applyKey ctrl d emits eof only on an empty buffer", () => {
  const nonEmpty = typeText(createEditorState(), "abc");
  const ignored = applyKey(nonEmpty, firstKey("\x04"));
  assert.equal(ignored.action, null);
  assert.equal(ignored.state.buffer, "abc");
  const empty = applyKey(createEditorState(), firstKey("\x04"));
  assert.deepEqual(empty.action, { type: "eof" });
});

test("applyKey ctrl l emits clear", () => {
  const before = typeText(createEditorState(), "abc");
  const result = applyKey(before, firstKey("\x0c"));
  assert.deepEqual(result.action, { type: "clear" });
  assert.equal(result.state.buffer, "abc");
});

test("applyKey does not mutate its input", () => {
  const before = createEditorState({ history: ["one"] });
  Object.freeze(before.history);
  Object.freeze(before);
  const result = applyKey(before, firstKey("a"));
  assert.notEqual(result.state, before);
  assert.equal(before.buffer, "");
  assert.equal(before.cursor, 0);
  assert.deepEqual(before.history, ["one"]);
  assert.equal(result.state.buffer, "a");
});

test("createInput works with fake non TTY stdin", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const submits = [];
  const renders = [];
  const input = createInput({
    stdin,
    stdout,
    onSubmit(value) {
      submits.push(value);
    },
    onRender(state) {
      renders.push(state.buffer);
    },
  });
  input.start();
  stdin.write("hi\r");
  await new Promise((resolve) => setImmediate(resolve));
  input.stop();
  assert.deepEqual(submits, ["hi"]);
  assert.equal(input.getState().buffer, "");
  assert.deepEqual(input.getState().history, ["hi"]);
  assert.ok(renders.includes("h"));
});

test("createInput stop is idempotent and restores raw mode", () => {
  const stdin = new PassThrough();
  const rawCalls = [];
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (value) => {
    rawCalls.push(value);
    stdin.isRaw = value;
  };
  const input = createInput({ stdin, stdout: new PassThrough() });
  input.start();
  assert.equal(stdin.listenerCount("data"), 1);
  input.stop();
  input.stop();
  assert.deepEqual(rawCalls, [true, false]);
  assert.equal(stdin.listenerCount("data"), 0);
});
