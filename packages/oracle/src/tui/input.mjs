const EMPTY = Buffer.alloc(0);

const SPECIAL_NAMES = new Set([
  "return",
  "backspace",
  "tab",
  "escape",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "delete",
  "insert",
  "pageup",
  "pagedown",
  "unknown",
]);

const CSI_FINALS = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

const TILDE_CODES = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
};

function makeKey({ name = null, ctrl = false, meta = false, shift = false, sequence = "" }) {
  return { name, ctrl, meta, shift, sequence };
}

function utf8Length(lead) {
  if (lead < 0x80) return 1;
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

function isFinalByte(b) {
  return b >= 0x40 && b <= 0x7e;
}

function charKey(text) {
  const lower = text.toLowerCase();
  return makeKey({
    name: lower,
    shift: text !== lower,
    sequence: text,
  });
}

function controlKey(b) {
  if (b === 0x0d) return makeKey({ name: "return", sequence: "\r" });
  if (b === 0x0a) return makeKey({ name: "return", sequence: "\n" });
  if (b === 0x09) return makeKey({ name: "tab", sequence: "\t" });
  if (b === 0x7f) return makeKey({ name: "backspace", sequence: "\u007f" });
  if (b === 0x08) return makeKey({ name: "backspace", sequence: "\b" });
  if (b >= 0x01 && b <= 0x1a) {
    return makeKey({
      name: String.fromCharCode(b + 0x60),
      ctrl: true,
      sequence: String.fromCharCode(b),
    });
  }
  return makeKey({ name: "unknown", sequence: String.fromCharCode(b) });
}

function csiKey(sequence) {
  const match = /^\u001b[\[O](\d*)(?:;(\d+))?(.)$/s.exec(sequence);
  if (!match) return makeKey({ name: "unknown", sequence });
  const first = match[1] === "" ? null : Number(match[1]);
  const second = match[2] === undefined ? null : Number(match[2]);
  const final = match[3];

  let name = null;
  let modifier = second;
  if (final === "~") {
    name = TILDE_CODES[first] ?? null;
  } else {
    name = CSI_FINALS[final] ?? null;
    if (modifier === null && first !== null && first > 1) modifier = first;
  }
  if (!name) return makeKey({ name: "unknown", sequence });

  const bits = modifier === null ? 0 : Math.max(0, modifier - 1);
  return makeKey({
    name,
    shift: (bits & 1) !== 0,
    meta: (bits & 2) !== 0,
    ctrl: (bits & 4) !== 0,
    sequence,
  });
}

function decodeEscape(buf, start, keys, flush) {
  const escape = () => {
    keys.push(makeKey({ name: "escape", sequence: "\u001b" }));
    return 1;
  };
  if (start + 1 >= buf.length) return flush ? escape() : 0;

  const next = buf[start + 1];
  if (next === 0x5b || next === 0x4f) {
    let j = start + 2;
    while (j < buf.length && !isFinalByte(buf[j])) j += 1;
    if (j >= buf.length) return flush ? escape() : 0;
    keys.push(csiKey(buf.toString("utf8", start, j + 1)));
    return j + 1 - start;
  }
  if (next === 0x1b) return escape();

  const width = utf8Length(next);
  if (start + 1 + width > buf.length) return flush ? escape() : 0;
  const text = buf.toString("utf8", start + 1, start + 1 + width);
  const lower = text.toLowerCase();
  keys.push(makeKey({
    name: lower,
    meta: true,
    shift: text !== lower,
    sequence: `\u001b${text}`,
  }));
  return 1 + width;
}

function decodeChunk(buf, flush) {
  const keys = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x1b) {
      const consumed = decodeEscape(buf, i, keys, flush);
      if (consumed === 0) return { keys, rest: Buffer.from(buf.subarray(i)) };
      i += consumed;
      continue;
    }
    if (b < 0x20 || b === 0x7f) {
      keys.push(controlKey(b));
      i += 1;
      continue;
    }
    const width = utf8Length(b);
    if (i + width > buf.length) {
      if (!flush) return { keys, rest: Buffer.from(buf.subarray(i)) };
      keys.push(charKey(buf.toString("utf8", i)));
      return { keys, rest: EMPTY };
    }
    keys.push(charKey(buf.toString("utf8", i, i + width)));
    i += width;
  }
  return { keys, rest: EMPTY };
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk === null || chunk === undefined) return EMPTY;
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.from(chunk);
}

let decodeKeysPending = EMPTY;

export function decodeKeys(chunk) {
  const buf = decodeKeysPending.length === 0
    ? toBuffer(chunk)
    : Buffer.concat([decodeKeysPending, toBuffer(chunk)]);
  const { keys, rest } = decodeChunk(buf, false);
  if (rest.length === 1 && rest[0] === 0x1b) {
    decodeKeysPending = EMPTY;
    return [...keys, makeKey({ name: "escape", sequence: "\u001b" })];
  }
  decodeKeysPending = rest;
  return keys;
}

export function createDecoder() {
  let pending = EMPTY;
  return {
    push(chunk) {
      const buf = pending.length === 0
        ? toBuffer(chunk)
        : Buffer.concat([pending, toBuffer(chunk)]);
      const { keys, rest } = decodeChunk(buf, false);
      pending = rest;
      return keys;
    },
    flush() {
      if (pending.length === 0) return [];
      const { keys } = decodeChunk(pending, true);
      pending = EMPTY;
      return keys;
    },
    get pending() {
      return pending.length;
    },
  };
}

export function createEditorState({ history = [] } = {}) {
  const entries = [...history];
  return {
    buffer: "",
    cursor: 0,
    history: entries,
    historyIndex: entries.length,
    draft: "",
  };
}

function stepLeft(text, index) {
  if (index <= 0) return 0;
  const prev = index - 1;
  const code = text.charCodeAt(prev);
  if (code >= 0xdc00 && code <= 0xdfff && prev > 0) {
    const lead = text.charCodeAt(prev - 1);
    if (lead >= 0xd800 && lead <= 0xdbff) return prev - 1;
  }
  return prev;
}

function stepRight(text, index) {
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) return index + 2;
  return index + 1;
}

function next(state, patch) {
  return { ...state, ...patch };
}

function live(state, patch) {
  return next(state, { ...patch, historyIndex: state.history.length, draft: "" });
}

function isPrintable(key) {
  if (key.ctrl || key.meta) return false;
  if (!key.sequence) return false;
  if (SPECIAL_NAMES.has(key.name)) return false;
  for (const ch of key.sequence) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function killPrevWord(text, cursor) {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1])) i -= 1;
  while (i > 0 && !/\s/.test(text[i - 1])) i -= 1;
  return i;
}

function historyUp(state) {
  if (state.historyIndex <= 0) return { state: next(state, {}), action: null };
  const atLive = state.historyIndex >= state.history.length;
  const index = state.historyIndex - 1;
  const buffer = state.history[index] ?? "";
  return {
    state: next(state, {
      buffer,
      cursor: buffer.length,
      historyIndex: index,
      draft: atLive ? state.buffer : state.draft,
    }),
    action: null,
  };
}

function historyDown(state) {
  if (state.historyIndex >= state.history.length) return { state: next(state, {}), action: null };
  const index = state.historyIndex + 1;
  const restored = index >= state.history.length;
  const buffer = restored ? state.draft : (state.history[index] ?? "");
  return {
    state: next(state, {
      buffer,
      cursor: buffer.length,
      historyIndex: index,
      draft: restored ? "" : state.draft,
    }),
    action: null,
  };
}

function submit(state) {
  const value = state.buffer.trim();
  if (value === "") {
    return {
      state: live(state, { buffer: "", cursor: 0 }),
      action: null,
    };
  }
  const history = state.history[state.history.length - 1] === value
    ? [...state.history]
    : [...state.history, value];
  return {
    state: next(state, {
      buffer: "",
      cursor: 0,
      history,
      historyIndex: history.length,
      draft: "",
    }),
    action: { type: "submit", value },
  };
}

export function applyKey(state, key) {
  if (!key) return { state: next(state, {}), action: null };
  const { buffer, cursor } = state;

  if (key.ctrl && !key.meta) {
    switch (key.name) {
      case "c":
        return { state: live(state, { buffer: "", cursor: 0 }), action: { type: "cancel" } };
      case "d":
        if (buffer === "") return { state: next(state, {}), action: { type: "eof" } };
        return { state: next(state, {}), action: null };
      case "l":
        return { state: next(state, {}), action: { type: "clear" } };
      case "a":
        return { state: next(state, { cursor: 0 }), action: null };
      case "e":
        return { state: next(state, { cursor: buffer.length }), action: null };
      case "u":
        return {
          state: next(state, { buffer: buffer.slice(cursor), cursor: 0 }),
          action: null,
        };
      case "k":
        return { state: next(state, { buffer: buffer.slice(0, cursor) }), action: null };
      case "w": {
        const start = killPrevWord(buffer, cursor);
        return {
          state: next(state, {
            buffer: buffer.slice(0, start) + buffer.slice(cursor),
            cursor: start,
          }),
          action: null,
        };
      }
      case "b":
        return { state: next(state, { cursor: stepLeft(buffer, cursor) }), action: null };
      case "f":
        return { state: next(state, { cursor: stepRight(buffer, cursor) }), action: null };
      default:
        return { state: next(state, {}), action: null };
    }
  }

  switch (key.name) {
    case "return":
      return submit(state);
    case "left":
      return { state: next(state, { cursor: stepLeft(buffer, cursor) }), action: null };
    case "right":
      return { state: next(state, { cursor: stepRight(buffer, cursor) }), action: null };
    case "home":
      return { state: next(state, { cursor: 0 }), action: null };
    case "end":
      return { state: next(state, { cursor: buffer.length }), action: null };
    case "up":
      return historyUp(state);
    case "down":
      return historyDown(state);
    case "backspace": {
      if (cursor === 0) return { state: next(state, {}), action: null };
      const start = stepLeft(buffer, cursor);
      return {
        state: next(state, {
          buffer: buffer.slice(0, start) + buffer.slice(cursor),
          cursor: start,
        }),
        action: null,
      };
    }
    case "delete": {
      if (cursor >= buffer.length) return { state: next(state, {}), action: null };
      const end = stepRight(buffer, cursor);
      return {
        state: next(state, { buffer: buffer.slice(0, cursor) + buffer.slice(end) }),
        action: null,
      };
    }
    default:
      break;
  }

  if (isPrintable(key)) {
    const text = key.sequence;
    return {
      state: next(state, {
        buffer: buffer.slice(0, cursor) + text + buffer.slice(cursor),
        cursor: cursor + text.length,
      }),
      action: null,
    };
  }

  return { state: next(state, {}), action: null };
}

export function createInput(options = {}) {
  const {
    stdin,
    stdout,
    history = [],
    onSubmit,
    onCancel,
    onEof,
    onClear,
    onRender,
  } = options;

  const input = stdin ?? process.stdin;
  const output = stdout ?? process.stdout;
  const decoder = createDecoder();
  const handlers = {
    submit: onSubmit,
    cancel: onCancel,
    eof: onEof,
    clear: onClear,
  };

  let state = createEditorState({ history });
  let started = false;
  let rawApplied = false;
  let priorRaw = false;

  const emit = (action) => {
    if (!action) return;
    const handler = handlers[action.type];
    if (typeof handler === "function") handler(action.value, state);
  };

  const onData = (chunk) => {
    for (const key of decoder.push(chunk)) {
      const result = applyKey(state, key);
      state = result.state;
      emit(result.action);
      if (typeof onRender === "function") onRender(state);
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      if (input.isTTY && typeof input.setRawMode === "function") {
        priorRaw = input.isRaw === true;
        input.setRawMode(true);
        rawApplied = true;
      }
      if (typeof input.resume === "function") input.resume();
      input.on("data", onData);
      if (typeof onRender === "function") onRender(state);
    },
    stop() {
      if (!started) return;
      started = false;
      if (typeof input.off === "function") input.off("data", onData);
      else if (typeof input.removeListener === "function") input.removeListener("data", onData);
      if (rawApplied && typeof input.setRawMode === "function") {
        input.setRawMode(priorRaw);
        rawApplied = false;
      }
      if (typeof input.pause === "function") input.pause();
    },
    getState() {
      return state;
    },
    setState(nextState) {
      state = nextState;
      return state;
    },
    write(text) {
      if (output && typeof output.write === "function") output.write(text);
    },
    get isRunning() {
      return started;
    },
  };
}
