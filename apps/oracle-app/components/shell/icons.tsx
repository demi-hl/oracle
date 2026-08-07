// Stroke-based SVG icons for the mobile shell, currentColor, no emoji.
// Matches the house style in components/Icons.tsx (24 viewBox, round caps).
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function base(props: P) {
  return {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

export const ChatIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z" />
  </svg>
);

export const HomeIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="4" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="14" width="7" height="6" rx="1.6" />
    <rect x="13.5" y="14" width="7" height="6" rx="1.6" />
  </svg>
);

export const PortfolioIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="4.5" />
    <path d="M8 5.5v5M6.4 6.5h2.3a1.2 1.2 0 0 1 0 2.4H7.3a1.2 1.2 0 0 0 0 2.4h2.3" />
    <path d="M13.5 6.5H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-4" />
    <path d="M15.5 13.5h3" />
  </svg>
);

export const SwapIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 8.5h13" />
    <path d="M13.5 5 17 8.5 13.5 12" />
    <path d="M20 15.5H7" />
    <path d="M10.5 12 7 15.5 10.5 19" />
  </svg>
);

export const NftIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2.4" />
    <circle cx="9" cy="9" r="1.8" />
    <path d="M4 16.5 9.5 12l4 3.2L17 12l3 3" />
  </svg>
);

export const ReposIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="8" r="2.4" />
    <path d="M6 8.4v7.2M18 10.4c0 3-2 4.2-5 4.7" />
  </svg>
);

export const EditorIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="m9 8-4 4 4 4M15 8l4 4-4 4M13 5l-2 14" />
  </svg>
);

export const TerminalIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </svg>
);

export const DiffIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 3v12M6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
    <path d="M18 9v8M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM11 6h4a2 2 0 0 1 2 2" />
  </svg>
);

export const FleetIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="6" rx="1.6" />
    <rect x="3" y="14" width="18" height="6" rx="1.6" />
    <path d="M7 7h.01M7 17h.01" />
  </svg>
);

export const KanbanIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M8 7v7M12 7v10M16 7v4" />
  </svg>
);

export const PullRequestIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="18" cy="18" r="2.4" />
    <path d="M6 8.4v7.2M18 15.6V11a3 3 0 0 0-3-3h-3l2.4-2.4M11.6 10.4 14 8" />
  </svg>
);

export const AutomationIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const SettingsIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </svg>
);

export const MoreIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </svg>
);

export const PaletteIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.5 1.6-1.5H16a5 5 0 0 0 5-5c0-3.9-4-7.5-9-7.5Z" />
    <circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="16.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const CheckIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="m5 12 5 5L20 7" />
  </svg>
);

export const ChevronRightIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const ChevronUpDownIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
  </svg>
);

export const ChevronDownIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const CompressIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5" />
    <path d="M8 3v5H3" stroke="none" fill="currentColor" />
    <path d="M21 3v5h-5" stroke="none" fill="currentColor" />
    <path d="M8 21v-5H3" stroke="none" fill="currentColor" />
    <path d="M21 21v-5h-5" stroke="none" fill="currentColor" />
    <circle cx="12" cy="12" r="2" stroke="none" fill="currentColor" opacity="0.4" />
  </svg>
);

export const ClockIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const CpuIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
  </svg>
);

export const BranchIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="7" r="2.2" />
    <path d="M6 8.2v7.6M18 9.2c0 3.5-2.4 4.6-6 5" />
  </svg>
);

export const SendIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
  </svg>
);

export const CloseIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const SkillsIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="4" y="4" width="6" height="6" rx="1.5" />
    <rect x="14" y="4" width="6" height="6" rx="1.5" />
    <path d="M7 15c0-2 2-3 5-3s5 1 5 3" />
    <circle cx="7" cy="17" r="2" />
    <circle cx="17" cy="17" r="2" />
  </svg>
);

export const KeyIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.5 12.5 21 2M16 7l3 3M14 9l2.5 2.5" />
  </svg>
);

export const ChartIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 3v18h18" />
    <rect x="7" y="12" width="3" height="6" rx="0.5" />
    <rect x="12" y="8" width="3" height="10" rx="0.5" />
    <rect x="17" y="5" width="3" height="13" rx="0.5" />
  </svg>
);

export const ShieldIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l7 3v5.5c0 4.3-2.9 8.2-7 9.5-4.1-1.3-7-5.2-7-9.5V6l7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

export const DownloadIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3v12M8 11l4 4 4-4M4 19h16" />
  </svg>
);

export const PlugIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5" />
  </svg>
);

// Gem: a stylized obsidian diamond.
export const VaultIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 2 4 8.5 12 22l8-13.5L12 2Z" />
    <path d="M4 8.5h16M12 2v20M8 8.5 12 22l4-13.5" />
  </svg>
);

// Router: a hub/switch with an antenna — the OpenRouter dispatch pane.
export const RouterIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="14" width="18" height="7" rx="2" />
    <path d="M7 14V8a5 5 0 0 1 10 0v6M7 17.5h.01M11 17.5h.01" />
  </svg>
);

// Journey: a constellation / star-map — the learning Star Map pane.
export const JourneyIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 6l1.2 2.6L9 9.8 6.5 11 5 14l-1.5-3L1 9.8l2.8-1.2L5 6Z" />
    <circle cx="16.5" cy="7.5" r="1.3" />
    <circle cx="19" cy="15" r="1.3" />
    <circle cx="11" cy="18" r="1.3" />
    <path d="M6.2 11.5 11 18M11 18l8-3M16.5 7.5 19 15" />
  </svg>
);

// MoA: multiple reference agents converge into one aggregator.
export const MoaIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="12" cy="12" r="2.2" />
    <circle cx="19" cy="12" r="2.8" />
    <path d="M8 7.2 10.2 10M8 16.8l2.2-2.8M14.2 12H16" />
  </svg>
);
