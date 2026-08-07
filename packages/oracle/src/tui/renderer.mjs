const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_LINE = "\u001b[2K";
const ERASE_DOWN = "\u001b[0J";
const DEFAULT_ROWS = 24;
const DEFAULT_COLUMNS = 80;
const ANSI_SOURCE = "\u001b\\[[0-9;?]*[a-zA-Z]";

function ansiRegex() {
  return new RegExp(ANSI_SOURCE, "g");
}

export function stripAnsi(text) {
  return String(text ?? "").replace(ansiRegex(), "");
}

function inRanges(code, ranges) {
  return ranges.some(([start, end]) => code >= start && code <= end);
}

function codePointWidth(code) {
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (inRanges(code, [
    [0x0300, 0x036f],
    [0x0483, 0x0489],
    [0x0591, 0x05bd],
    [0x05bf, 0x05bf],
    [0x05c1, 0x05c2],
    [0x05c4, 0x05c5],
    [0x05c7, 0x05c7],
    [0x0610, 0x061a],
    [0x064b, 0x065f],
    [0x0670, 0x0670],
    [0x06d6, 0x06dd],
    [0x06df, 0x06e4],
    [0x06e7, 0x06e8],
    [0x06ea, 0x06ed],
    [0x0711, 0x0711],
    [0x0730, 0x074a],
    [0x07a6, 0x07b0],
    [0x07eb, 0x07f3],
    [0x0816, 0x0819],
    [0x081b, 0x0823],
    [0x0825, 0x0827],
    [0x0829, 0x082d],
    [0x0859, 0x085b],
    [0x08d3, 0x08e1],
    [0x08e3, 0x0903],
    [0x093a, 0x093c],
    [0x0941, 0x0948],
    [0x094d, 0x094d],
    [0x0951, 0x0957],
    [0x0962, 0x0963],
    [0x0981, 0x0981],
    [0x09bc, 0x09bc],
    [0x09c1, 0x09c4],
    [0x09cd, 0x09cd],
    [0x09e2, 0x09e3],
    [0x0a01, 0x0a02],
    [0x0a3c, 0x0a3c],
    [0x0a41, 0x0a42],
    [0x0a47, 0x0a48],
    [0x0a4b, 0x0a4d],
    [0x0a51, 0x0a51],
    [0x0a70, 0x0a71],
    [0x0a75, 0x0a75],
    [0x0a81, 0x0a82],
    [0x0abc, 0x0abc],
    [0x0ac1, 0x0ac5],
    [0x0ac7, 0x0ac8],
    [0x0acd, 0x0acd],
    [0x0ae2, 0x0ae3],
    [0x0b01, 0x0b01],
    [0x0b3c, 0x0b3c],
    [0x0b3f, 0x0b3f],
    [0x0b41, 0x0b44],
    [0x0b4d, 0x0b4d],
    [0x0b56, 0x0b56],
    [0x0b62, 0x0b63],
    [0x0b82, 0x0b82],
    [0x0bc0, 0x0bc0],
    [0x0bcd, 0x0bcd],
    [0x0c00, 0x0c00],
    [0x0c3e, 0x0c40],
    [0x0c46, 0x0c48],
    [0x0c4a, 0x0c4d],
    [0x0c55, 0x0c56],
    [0x0c62, 0x0c63],
    [0x0c81, 0x0c81],
    [0x0cbc, 0x0cbc],
    [0x0cbf, 0x0cbf],
    [0x0cc6, 0x0cc6],
    [0x0ccc, 0x0ccd],
    [0x0ce2, 0x0ce3],
    [0x0d01, 0x0d01],
    [0x0d41, 0x0d44],
    [0x0d4d, 0x0d4d],
    [0x0d62, 0x0d63],
    [0x0dd2, 0x0dd4],
    [0x0dd6, 0x0dd6],
    [0x0e31, 0x0e31],
    [0x0e34, 0x0e3a],
    [0x0e47, 0x0e4e],
    [0x0eb1, 0x0eb1],
    [0x0eb4, 0x0eb9],
    [0x0ebb, 0x0ebc],
    [0x0ec8, 0x0ecd],
    [0x0f18, 0x0f19],
    [0x0f35, 0x0f35],
    [0x0f37, 0x0f37],
    [0x0f39, 0x0f39],
    [0x0f71, 0x0f7e],
    [0x0f80, 0x0f84],
    [0x0f86, 0x0f87],
    [0x0f8d, 0x0f97],
    [0x0f99, 0x0fbc],
    [0x0fc6, 0x0fc6],
    [0x102d, 0x1030],
    [0x1032, 0x1037],
    [0x1039, 0x103a],
    [0x103d, 0x103e],
    [0x1058, 0x1059],
    [0x105e, 0x1060],
    [0x1071, 0x1074],
    [0x1082, 0x1082],
    [0x1085, 0x1086],
    [0x108d, 0x108d],
    [0x109d, 0x109d],
    [0x135d, 0x135f],
    [0x1712, 0x1714],
    [0x1732, 0x1734],
    [0x1752, 0x1753],
    [0x1772, 0x1773],
    [0x17b4, 0x17b5],
    [0x17b7, 0x17bd],
    [0x17c6, 0x17c6],
    [0x17c9, 0x17d3],
    [0x17dd, 0x17dd],
    [0x180b, 0x180d],
    [0x1885, 0x1886],
    [0x18a9, 0x18a9],
    [0x1920, 0x1922],
    [0x1927, 0x1928],
    [0x1932, 0x1932],
    [0x1939, 0x193b],
    [0x1a17, 0x1a18],
    [0x1a1b, 0x1a1b],
    [0x1a56, 0x1a56],
    [0x1a58, 0x1a5e],
    [0x1a60, 0x1a60],
    [0x1a62, 0x1a62],
    [0x1a65, 0x1a6c],
    [0x1a73, 0x1a7c],
    [0x1a7f, 0x1a7f],
    [0x1ab0, 0x1aff],
    [0x1b00, 0x1b03],
    [0x1b34, 0x1b34],
    [0x1b36, 0x1b3a],
    [0x1b3c, 0x1b3c],
    [0x1b42, 0x1b42],
    [0x1b6b, 0x1b73],
    [0x1b80, 0x1b81],
    [0x1ba2, 0x1ba5],
    [0x1ba8, 0x1ba9],
    [0x1bab, 0x1bad],
    [0x1be6, 0x1be6],
    [0x1be8, 0x1be9],
    [0x1bed, 0x1bed],
    [0x1bef, 0x1bf1],
    [0x1c2c, 0x1c33],
    [0x1c36, 0x1c37],
    [0x1cd0, 0x1cd2],
    [0x1cd4, 0x1ce0],
    [0x1ce2, 0x1ce8],
    [0x1ced, 0x1ced],
    [0x1cf4, 0x1cf4],
    [0x1cf8, 0x1cf9],
    [0x1dc0, 0x1dff],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x206f],
    [0x20d0, 0x20ff],
    [0xfe00, 0xfe0f],
    [0xfe20, 0xfe2f],
    [0xe0100, 0xe01ef],
  ])) return 0;
  if (inRanges(code, [
    [0x1100, 0x115f],
    [0x231a, 0x231b],
    [0x2329, 0x232a],
    [0x23e9, 0x23ec],
    [0x23f0, 0x23f0],
    [0x23f3, 0x23f3],
    [0x25fd, 0x25fe],
    [0x2614, 0x2615],
    [0x2648, 0x2653],
    [0x267f, 0x267f],
    [0x2693, 0x2693],
    [0x26a1, 0x26a1],
    [0x26aa, 0x26ab],
    [0x26bd, 0x26be],
    [0x26c4, 0x26c5],
    [0x26ce, 0x26ce],
    [0x26d4, 0x26d4],
    [0x26ea, 0x26ea],
    [0x26f2, 0x26f3],
    [0x26f5, 0x26f5],
    [0x26fa, 0x26fa],
    [0x26fd, 0x26fd],
    [0x2705, 0x2705],
    [0x270a, 0x270b],
    [0x2728, 0x2728],
    [0x274c, 0x274c],
    [0x274e, 0x274e],
    [0x2753, 0x2755],
    [0x2757, 0x2757],
    [0x2795, 0x2797],
    [0x27b0, 0x27b0],
    [0x27bf, 0x27bf],
    [0x2b1b, 0x2b1c],
    [0x2b50, 0x2b50],
    [0x2b55, 0x2b55],
    [0x2e80, 0x303e],
    [0x3040, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe10, 0xfe19],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x1f300, 0x1f64f],
    [0x1f900, 0x1f9ff],
    [0x20000, 0x3fffd],
  ])) return 2;
  return 1;
}

function stringWidth(text) {
  let width = 0;
  for (const point of Array.from(text)) {
    width += codePointWidth(point.codePointAt(0));
  }
  return width;
}

export function visibleWidth(text) {
  return stringWidth(stripAnsi(text));
}

function isReset(sequence) {
  return /^\u001b\[0*m$/.test(sequence);
}

function takeVisible(chunk, budget) {
  let text = "";
  let width = 0;
  for (const point of Array.from(chunk)) {
    const nextWidth = codePointWidth(point.codePointAt(0));
    if (width + nextWidth > budget) break;
    text += point;
    width += nextWidth;
  }
  return { text, width };
}

export function truncateToWidth(text, max) {
  const source = String(text ?? "");
  if (max <= 0) return "";
  if (visibleWidth(source) <= max) return source;

  const re = ansiRegex();
  let out = "";
  let width = 0;
  let styled = false;
  let cursor = 0;
  let match = re.exec(source);

  while (match !== null) {
    const taken = takeVisible(source.slice(cursor, match.index), max - width);
    out += taken.text;
    width += taken.width;
    if (width >= max) return styled ? `${out}\u001b[0m` : out;
    out += match[0];
    if (match[0].endsWith("m")) styled = !isReset(match[0]);
    cursor = match.index + match[0].length;
    match = re.exec(source);
  }

  const tail = takeVisible(source.slice(cursor), max - width);
  out += tail.text;
  return styled ? `${out}\u001b[0m` : out;
}

function sameLines(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function createRenderer({ stdout, rows, columns } = {}) {
  if (!stdout || typeof stdout.write !== "function") {
    throw new TypeError("createRenderer requires a stdout with a write(string) method");
  }

  const fixedRows = Number.isFinite(rows) ? Math.trunc(rows) : null;
  const fixedColumns = Number.isFinite(columns) ? Math.trunc(columns) : null;

  let currentRows = fixedRows ?? (Number.isFinite(stdout.rows) ? Math.trunc(stdout.rows) : DEFAULT_ROWS);
  let currentColumns = fixedColumns ?? (Number.isFinite(stdout.columns) ? Math.trunc(stdout.columns) : DEFAULT_COLUMNS);

  let painted = [];
  let cursorRow = 0;
  let regionHeight = null;
  let forceFull = false;
  let disposed = false;

  const onResize = () => {
    if (fixedRows === null) currentRows = Number.isFinite(stdout.rows) ? Math.trunc(stdout.rows) : DEFAULT_ROWS;
    if (fixedColumns === null) currentColumns = Number.isFinite(stdout.columns) ? Math.trunc(stdout.columns) : DEFAULT_COLUMNS;
    forceFull = true;
  };

  const listens = typeof stdout.on === "function";
  if (listens) stdout.on("resize", onResize);

  function moveTo(row) {
    const delta = row - cursorRow;
    cursorRow = row;
    if (delta === 0) return "";
    if (delta < 0) return `\u001b[${-delta}A`;
    return `\u001b[${delta}B`;
  }

  function normalize(input) {
    const source = Array.isArray(input) ? input : [];
    let out = source.map((line) => truncateToWidth(String(line ?? ""), currentColumns));
    if (regionHeight !== null) {
      if (out.length > regionHeight) out = out.slice(0, regionHeight);
      while (out.length < regionHeight) out.push("");
    }
    return out;
  }

  function paint(target) {
    if (!forceFull && sameLines(painted, target)) return;

    const out = [HIDE_CURSOR];

    if (forceFull && painted.length > 0) {
      out.push(moveTo(0), "\r", ERASE_DOWN);
      painted = [];
      cursorRow = 0;
    }
    forceFull = false;

    const shared = Math.min(painted.length, target.length);
    for (let i = 0; i < shared; i += 1) {
      if (painted[i] === target[i]) continue;
      out.push(moveTo(i), "\r", CLEAR_LINE, target[i]);
    }

    if (target.length > painted.length) {
      if (painted.length > 0) out.push(moveTo(painted.length - 1));
      for (let i = painted.length; i < target.length; i += 1) {
        if (i > 0) out.push("\n");
        out.push("\r", CLEAR_LINE, target[i]);
        cursorRow = i;
      }
    } else if (target.length < painted.length) {
      out.push(moveTo(target.length), "\r", ERASE_DOWN);
    }

    if (target.length > 0) out.push(moveTo(target.length - 1));
    out.push(SHOW_CURSOR);

    painted = target;
    stdout.write(out.join(""));
  }

  return {
    render(lines) {
      if (disposed) return;
      paint(normalize(lines));
    },

    writeAbove(text) {
      if (disposed) return;
      const body = String(text ?? "");
      let head = HIDE_CURSOR;
      if (painted.length > 0) head += `${moveTo(0)}\r${ERASE_DOWN}`;
      head += body.endsWith("\n") || body === "" ? body : `${body}\n`;
      stdout.write(head);

      const saved = painted;
      painted = [];
      cursorRow = 0;
      if (saved.length > 0) {
        paint(saved);
      } else {
        stdout.write(SHOW_CURSOR);
      }
    },

    clear() {
      if (disposed) return;
      let out = HIDE_CURSOR;
      if (painted.length > 0) out += `${moveTo(0)}\r${ERASE_DOWN}`;
      out += SHOW_CURSOR;
      stdout.write(out);
      painted = [];
      cursorRow = 0;
      forceFull = false;
    },

    setLines(n) {
      regionHeight = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
    },

    getLines() {
      return painted.slice();
    },

    getSize() {
      return { rows: currentRows, columns: currentColumns };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (listens) {
        const off = typeof stdout.off === "function" ? stdout.off : stdout.removeListener;
        if (typeof off === "function") off.call(stdout, "resize", onResize);
      }
      stdout.write(SHOW_CURSOR);
    },
  };
}

export default createRenderer;
