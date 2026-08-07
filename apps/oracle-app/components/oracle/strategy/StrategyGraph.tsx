"use client";

import { useMemo } from "react";

const ORACLE_BLUE = "#7CC4FF";
const DEMI_CYAN = "#B8F0FF";
const HAIRLINE = "rgba(124,196,255,.16)";
const MUTE = "#9FB8D2";
const INK = "#F4F9FE";
const BG = "#0B1018";
const ENTRY = "rgba(124,196,255,.22)";
const EXIT = "rgba(255,139,139,.18)";
const EXIT_STROKE = "#FF8B8B";

export interface StrategyGraphNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  config?: Record<string, unknown>;
  inputs?: string[];
  input?: string | string[];
  left?: string;
  right?: string;
}

export interface StrategyGraphProps {
  nodes: StrategyGraphNode[];
  parseError?: string | null;
}

type LayoutNode = {
  id: string;
  type: string;
  configText: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "entry" | "exit" | "other";
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function compactConfig(node: StrategyGraphNode): string {
  const raw = node.params ?? node.config ?? {};
  if (!isRecord(raw)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${String(v)}`);
    }
  }
  const text = parts.join(" ");
  return text.length > 42 ? `${text.slice(0, 40)}..` : text;
}

function nodeKind(type: string): "entry" | "exit" | "other" {
  const t = type.toLowerCase();
  if (t === "entry" || t.endsWith(".entry") || t.includes("entry")) return "entry";
  if (
    t === "exit" ||
    t === "stop" ||
    t === "take_profit" ||
    t.endsWith(".exit") ||
    t.includes("exit") ||
    t.includes("take_profit") ||
    t.includes("stop")
  ) {
    return "exit";
  }
  return "other";
}

function refIds(node: StrategyGraphNode): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.trim()) out.push(item.trim());
      }
    }
  };
  push(node.inputs);
  push(node.input);
  push(node.left);
  push(node.right);
  return out;
}

function layoutNodes(nodes: StrategyGraphNode[]): LayoutNode[] {
  const colW = 168;
  const rowH = 86;
  const padX = 28;
  const padY = 28;
  const perRow = Math.max(1, Math.min(3, nodes.length));
  return nodes.map((n, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    return {
      id: n.id,
      type: n.type || "unknown",
      configText: compactConfig(n),
      x: padX + col * colW,
      y: padY + row * rowH,
      w: 148,
      h: 58,
      kind: nodeKind(n.type || ""),
    };
  });
}

export function StrategyGraph({ nodes, parseError = null }: StrategyGraphProps) {
  const layout = useMemo(() => layoutNodes(nodes), [nodes]);
  const byId = useMemo(() => new Map(layout.map((n) => [n.id, n])), [layout]);

  const edges = useMemo(() => {
    const lines: { key: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const src of nodes) {
      const from = byId.get(src.id);
      if (!from) continue;
      for (const ref of refIds(src)) {
        const to = byId.get(ref);
        if (!to) continue;
        lines.push({
          key: `${src.id}->${ref}`,
          x1: from.x + from.w / 2,
          y1: from.y + from.h,
          x2: to.x + to.w / 2,
          y2: to.y,
        });
      }
    }
    // Fallback chain by order when no explicit refs exist.
    if (lines.length === 0 && layout.length > 1) {
      for (let i = 0; i < layout.length - 1; i += 1) {
        const a = layout[i];
        const b = layout[i + 1];
        lines.push({
          key: `order-${a.id}-${b.id}`,
          x1: a.x + a.w / 2,
          y1: a.y + a.h,
          x2: b.x + b.w / 2,
          y2: b.y,
        });
      }
    }
    return lines;
  }, [nodes, byId, layout]);

  const viewW = useMemo(() => {
    if (layout.length === 0) return 320;
    const maxX = Math.max(...layout.map((n) => n.x + n.w));
    return Math.max(320, maxX + 28);
  }, [layout]);

  const viewH = useMemo(() => {
    if (layout.length === 0) return 160;
    const maxY = Math.max(...layout.map((n) => n.y + n.h));
    return Math.max(160, maxY + 28);
  }, [layout]);

  if (parseError) {
    return (
      <div
        className="flex min-h-[200px] flex-col justify-center border px-4 py-6"
        style={{ borderColor: HAIRLINE, background: BG }}
        role="status"
      >
        <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em]" style={{ color: EXIT_STROKE }}>
          Graph invalid
        </p>
        <p className="mt-2 text-[0.72rem] leading-relaxed" style={{ color: MUTE }}>
          Unable to parse strategy graph: {parseError}
        </p>
      </div>
    );
  }

  if (layout.length === 0) {
    return (
      <div
        className="flex min-h-[200px] flex-col justify-center border px-4 py-6"
        style={{ borderColor: HAIRLINE, background: BG }}
        role="status"
      >
        <p className="font-mono-ui text-[0.55rem] uppercase tracking-[0.16em]" style={{ color: ORACLE_BLUE }}>
          Graph empty
        </p>
        <p className="mt-2 text-[0.72rem] leading-relaxed" style={{ color: MUTE }}>
          No nodes to render. Validate a strategy DSL or draft one to populate the graph.
        </p>
      </div>
    );
  }

  const fallbackText = layout.map((n) => `${n.type}:${n.id}`).join(" | ");

  return (
    <div className="w-full max-w-full overflow-hidden border" style={{ borderColor: HAIRLINE, background: BG }}>
      <svg
        viewBox={`0 0 ${viewW} ${viewH}`}
        width="100%"
        height="100%"
        className="block h-auto w-full max-w-full"
        role="img"
        aria-label="Strategy graph diagram"
        preserveAspectRatio="xMidYMid meet"
      >
        <title>Strategy graph</title>
        <desc>
          Responsive SVG diagram of parsed strategy nodes and references. Entry and exit rule nodes are visually
          distinguished.
        </desc>
        {edges.map((e) => (
          <line
            key={e.key}
            x1={e.x1}
            y1={e.y1}
            x2={e.x2}
            y2={e.y2}
            stroke={ORACLE_BLUE}
            strokeOpacity={0.45}
            strokeWidth={1.25}
          />
        ))}
        {layout.map((n) => {
          const fill = n.kind === "entry" ? ENTRY : n.kind === "exit" ? EXIT : "rgba(17,25,37,.92)";
          const stroke = n.kind === "exit" ? EXIT_STROKE : n.kind === "entry" ? DEMI_CYAN : HAIRLINE;
          return (
            <g key={n.id}>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                fill={fill}
                stroke={stroke}
                strokeWidth={1.25}
              />
              <text
                x={n.x + 8}
                y={n.y + 16}
                fill={ORACLE_BLUE}
                fontSize={9}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {n.type}
              </text>
              <text
                x={n.x + 8}
                y={n.y + 32}
                fill={INK}
                fontSize={11}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {n.id}
              </text>
              {n.configText ? (
                <text
                  x={n.x + 8}
                  y={n.y + 48}
                  fill={MUTE}
                  fontSize={9}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {n.configText}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="sr-only">{fallbackText}</p>
      <p className="border-t px-3 py-2 font-mono-ui text-[0.52rem] leading-relaxed" style={{ borderColor: HAIRLINE, color: MUTE }}>
        {fallbackText}
      </p>
    </div>
  );
}
