// Additional stroke icons for Oracle data panes. Same house style as
// components/shell/icons.tsx (24 viewBox, currentColor, round caps).
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function base(props: P) {
  return {
    width: 18,
    height: 18,
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

export const FolderIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.6.8l.8 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

export const FolderOpenIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.6.8l.8 1.2H19a2 2 0 0 1 2 2v1H6.5a2 2 0 0 0-1.9 1.4L3 18Z" />
    <path d="m3 18 1.7-5.6A2 2 0 0 1 6.6 11H22l-1.8 5.6A2 2 0 0 1 18.3 18Z" />
  </svg>
);

export const FileIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </svg>
);

export const SaveIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 4h11l3 3v13H5Z" />
    <path d="M8 4v5h7M9 20v-5h6v5" />
  </svg>
);

export const SearchIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </svg>
);

export const ReplaceIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 4h5v5M19 4l-7 7M10 20H5v-5M5 20l7-7" />
  </svg>
);

export const PlusIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const NewWorkspaceIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.6.8l.8 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M12 11v5M9.5 13.5h5" />
  </svg>
);

// Laptop glyph = a worktree workspace (matches the Conductor reference).
export const WorktreeIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="4" y="5" width="16" height="10" rx="1.6" />
    <path d="M2.5 19h19" />
  </svg>
);

// Small ring = a plain branch / draft workspace.
export const DraftDotIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="4.5" />
  </svg>
);

export const SymbolIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 4c-2 0-2 2-2 4s0 4-2 4c2 0 2 2 2 4s0 4 2 4M16 4c2 0 2 2 2 4s0 4 2 4c-2 0-2 2-2 4s0 4-2 4" />
  </svg>
);

export const SparkleIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z" />
    <path d="M19 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z" />
  </svg>
);

export const RefreshIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
  </svg>
);

export const DotIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
  </svg>
);

export const PlayIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 4.5 19 12 7 19.5Z" />
  </svg>
);

export const TrashIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" />
  </svg>
);
