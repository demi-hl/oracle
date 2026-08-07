export const THEME = Object.freeze({
  accent: "#B8F0FF",
  prompt: "#B8F0FF",
  banner_title: "#B8F0FF",
  banner_accent: "#91C2D7",
  ui_label: "#A5D9EB",
  banner_text: "#EAF2F8",
  status_bar_strong: "#EAF2F8",
  banner_border: "#455867",
  input_rule: "#455867",
  session_border: "#455867",
  banner_dim: "#60717F",
  status_bar_dim: "#60717F",
  status_bar_bg: "#11161B",
  status_bar_text: "#91A2B1",
  ok: "#7EE7B5",
  error: "#FF7B7B",
  warn: "#F0C674",
  bad: "#FF9B71",
  selection_bg: "#23313B",
});

export function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return null;
  const expanded = value.length === 3
    ? [...value].map((character) => character.repeat(2)).join("")
    : value;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function colorSequence(code, hex, text) {
  const rgb = hexToRgb(hex);
  if (!rgb) return String(text);
  return `\u001B[${code};2;${rgb.r};${rgb.g};${rgb.b}m${String(text)}\u001B[0m`;
}

export function createPalette({ color = true } = {}) {
  const enabled = color && !Object.hasOwn(process.env, "NO_COLOR");
  if (!enabled) {
    return Object.freeze({
      fg: (_hex, text) => String(text),
      bg: (_hex, text) => String(text),
      bold: (text) => String(text),
      dim: (text) => String(text),
    });
  }
  return Object.freeze({
    fg: (hex, text) => colorSequence(38, hex, text),
    bg: (hex, text) => colorSequence(48, hex, text),
    bold: (text) => `\u001B[1m${String(text)}\u001B[0m`,
    dim: (text) => `\u001B[2m${String(text)}\u001B[0m`,
  });
}

const defaultPalette = createPalette();

export function fg(hex, text) {
  return defaultPalette.fg(hex, text);
}

export function bg(hex, text) {
  return defaultPalette.bg(hex, text);
}

export function bold(text) {
  return defaultPalette.bold(text);
}

export function dim(text) {
  return defaultPalette.dim(text);
}

export function stripAnsi(text) {
  return String(text).replace(/\u001B\[[0-9;]*m/g, "");
}
