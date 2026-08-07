import { stripAnsi, THEME } from "./theme.mjs";

const WORDMARK = Object.freeze([
  ["#B8F0FF", "    ██████  ████████   ██████    ██████  ░███   ██████    "],
  ["#B8F0FF", "   ███░░███░░███░░███ ░░░░░███  ███░░███ ░███  ███░░███   "],
  ["#ACDEEF", "   ░███ ░███ ░███ ░░░   ███████ ░███ ░░░  ░███ ░███████   "],
  ["#A5D9EB", "   ░███ ░███ ░███      ███░░███ ░███  ███ ░███ ░███░░░    "],
  ["#9FCBDD", "   ░░██████  █████    ░░████████░░██████  █████░░██████   "],
  ["#B8F0FF", "    ░░░░░░  ░░░░░      ░░░░░░░░  ░░░░░░  ░░░░░  ░░░░░░    "],
]);

const TAGLINE = "THE FUTURE IS AGENTIC  /  by DEMI";
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

function cellWidth(character) {
  if (/\p{Mark}/u.test(character)) return 0;
  const point = character.codePointAt(0);
  if (point === 0x200d || point === 0xfe0f) return 0;
  if (point >= 0x1100 && (
    point <= 0x115f || point === 0x2329 || point === 0x232a ||
    (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe19) ||
    (point >= 0xfe30 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x1f300 && point <= 0x1faff) ||
    (point >= 0x20000 && point <= 0x3fffd)
  )) return 2;
  return point < 0x20 || (point >= 0x7f && point < 0xa0) ? 0 : 1;
}

export function visibleWidth(text) {
  return [...stripAnsi(text)].reduce((width, character) => width + cellWidth(character), 0);
}

function truncateTo(text, width) {
  if (width <= 0) return "";
  const tokens = String(text).split(/(\u001B\[[0-9;]*m)/g);
  let result = "";
  let used = 0;
  let styled = false;
  for (const token of tokens) {
    if (!token) continue;
    if (ANSI_PATTERN.test(token)) {
      ANSI_PATTERN.lastIndex = 0;
      result += token;
      styled = token !== "\u001B[0m";
      continue;
    }
    ANSI_PATTERN.lastIndex = 0;
    for (const character of token) {
      const cells = cellWidth(character);
      if (used + cells > width) return styled ? `${result}\u001B[0m` : result;
      result += character;
      used += cells;
    }
  }
  return result;
}

export function padTo(text, width, align = "left") {
  const target = Math.max(0, Math.floor(Number(width) || 0));
  const value = truncateTo(String(text), target);
  const spaces = Math.max(0, target - visibleWidth(value));
  if (align === "right") return `${" ".repeat(spaces)}${value}`;
  if (align === "center") {
    const left = Math.floor(spaces / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(spaces - left)}`;
  }
  return `${value}${" ".repeat(spaces)}`;
}

export function wrapText(text, width) {
  const target = Math.max(1, Math.floor(Number(width) || 1));
  const out = [];
  for (const rawLine of String(text ?? "").split("\n")) {
    if (rawLine === "") {
      out.push("");
      continue;
    }
    let current = "";
    let used = 0;
    for (const word of rawLine.split(" ")) {
      const wordWidth = visibleWidth(word);
      if (used > 0 && used + 1 + wordWidth > target) {
        out.push(current);
        current = "";
        used = 0;
      }
      if (wordWidth > target) {
        if (used > 0) {
          out.push(current);
          current = "";
          used = 0;
        }
        let rest = word;
        while (visibleWidth(rest) > target) {
          const head = truncateTo(rest, target);
          out.push(head);
          rest = rest.slice(head.length);
        }
        current = rest;
        used = visibleWidth(rest);
        continue;
      }
      current = used === 0 ? word : `${current} ${word}`;
      used = used === 0 ? wordWidth : used + 1 + wordWidth;
    }
    out.push(current);
  }
  return out;
}

export function bannerGeometry(width) {
  const target = Math.max(0, Math.floor(Number(width) || 0));
  const panelWidth = Math.max(36, Math.min(target - 4, 76));
  const panelLeft = Math.max(0, Math.floor((target - panelWidth) / 2));
  const contentLeft = panelLeft + 3;
  const inner = Math.max(0, panelWidth - 6);
  return { target, panelWidth, panelLeft, contentLeft, inner };
}

function inkBounds(lines) {
  let first = Infinity;
  let last = -1;
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] !== " ") {
        if (i < first) first = i;
        if (i > last) last = i;
      }
    }
  }
  if (last < 0) return { offset: 0, width: 0 };
  return { offset: first, width: last - first + 1 };
}

export function centerPad(geometry, inkWidth, inkOffset = 0) {
  const { target, contentLeft, inner } = geometry;
  const desired = Math.round((target - inkWidth) / 2);
  const pad = desired - inkOffset - contentLeft;
  const ceiling = Math.max(0, inner - inkWidth - inkOffset);
  return Math.max(0, Math.min(ceiling, pad));
}

export function renderBanner({ width, palette }) {
  const geometry = bannerGeometry(width);
  const { target, panelWidth, panelLeft, inner } = geometry;
  if (target < 72 || inner <= 0) {
    return [
      padTo(palette.bold(palette.fg(THEME.accent, "oracle")), target, "center"),
      padTo(palette.fg(THEME.banner_text, TAGLINE), target, "center"),
    ];
  }

  const art = WORDMARK.map(([, line]) => line);
  const { offset, width: inkWidth } = inkBounds(art);
  const artPad = " ".repeat(centerPad(geometry, inkWidth, offset));
  const taglinePad = " ".repeat(centerPad(geometry, visibleWidth(TAGLINE)));

  const body = [];
  for (const [color, line] of WORDMARK) {
    body.push(palette.bold(palette.fg(color, `${artPad}${line.replace(/\s+$/, "")}`)));
  }
  body.push("");
  body.push(palette.bold(palette.fg(THEME.banner_text, `${taglinePad}${TAGLINE}`)));

  const border = (text) => palette.fg(THEME.banner_border, text);
  const shift = " ".repeat(panelLeft);
  const rule = "─".repeat(Math.max(0, panelWidth - 2));
  const frame = (middle) => padTo(`${shift}${middle}`, target);
  const out = [frame(`${border("╭")}${border(rule)}${border("╮")}`)];
  const blank = frame(`${border("│")}${" ".repeat(Math.max(0, panelWidth - 2))}${border("│")}`);
  out.push(blank);
  for (const line of body) {
    out.push(frame(`${border("│")}  ${padTo(line, inner)}  ${border("│")}`));
  }
  out.push(blank);
  out.push(frame(`${border("╰")}${border(rule)}${border("╯")}`));
  return out;
}

export function renderBox({ lines, width, palette, title = "" }) {
  const target = Math.max(2, Math.floor(Number(width) || 0));
  const innerWidth = Math.max(0, target - 2);
  const cleanTitle = truncateTo(String(title), Math.max(0, innerWidth - 2));
  const titleText = cleanTitle ? ` ${cleanTitle} ` : "";
  const topRule = `${titleText}${"─".repeat(Math.max(0, innerWidth - visibleWidth(titleText)))}`;
  const border = (text) => palette.fg(THEME.banner_border, text);
  return [
    `${border("╭")}${border(topRule)}${border("╮")}`,
    ...lines.map((line) => `${border("│")}${padTo(line, innerWidth)}${border("│")}`),
    `${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`,
  ];
}

export function compactTokens(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "0";
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return String(Math.round(value));
}

export function contextBar(percent, width) {
  const target = Math.max(0, Math.floor(Number(width) || 0));
  const numeric = Number(percent);
  const clamped = Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;
  const filled = Math.round(target * clamped / 100);
  return `${"█".repeat(filled)}${"░".repeat(target - filled)}`;
}

export function formatElapsed(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "0s";
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function renderStatusBar({
  model,
  contextTokens,
  contextLength,
  percent,
  effort,
  thinking,
  chain,
  width,
  palette,
}) {
  const target = Math.max(0, Math.floor(Number(width) || 0));
  const separator = palette.fg(THEME.status_bar_dim, " / ");
  const barWidth = target >= 120 ? 12 : target >= 60 ? 8 : 4;
  const tokens = Number(contextLength) > 0
    ? `${compactTokens(contextTokens)}/${compactTokens(contextLength)}`
    : compactTokens(contextTokens);
  const pct = Number.isFinite(Number(percent)) ? `${Math.round(Number(percent))}%` : "0%";

  const segments = [
    { text: String(model ?? ""), strong: true },
  ];
  // The gateway does not know context_max until the first turn completes.
  // Show nothing rather than a misleading "0 0%".
  if (Number(contextLength) > 0) {
    segments.push({ text: `ctx ${contextBar(percent, barWidth)} ${tokens} ${pct}` });
  }
  if (effort) segments.push({ text: String(effort) });
  if (thinking) segments.push({ text: String(thinking) });
  if (typeof chain === "string" && chain.length > 0) segments.push({ text: chain });

  // Drop optional trailing segments rather than letting the bar truncate mid-word.
  let kept = segments;
  const plainWidth = (list) => list.reduce(
    (total, segment, index) => total + visibleWidth(segment.text) + (index > 0 ? 3 : 0),
    0,
  );
  while (kept.length > 1 && plainWidth(kept) > target) kept = kept.slice(0, -1);

  const content = kept
    .map((segment) => (segment.strong
      ? palette.fg(THEME.status_bar_strong, segment.text)
      : palette.fg(THEME.status_bar_text, segment.text)))
    .join(separator);
  return palette.bg(THEME.status_bar_bg, padTo(content, target));
}
