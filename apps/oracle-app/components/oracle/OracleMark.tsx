import type { CSSProperties } from "react";

export interface OracleMarkProps {
  className?: string;
  iconOnly?: boolean;
  size?: number;
  label?: string;
}

const SERIF_STACK =
  '"Cormorant Garamond", "Iowan Old Style", "Palatino Linotype", Georgia, serif';

/**
 * Oracle's product-owned lens mark and wordmark lockup.
 *
 * The geometry stays stroke-based so it remains crisp in the compact mobile
 * header as well as the wider desktop pane. `currentColor` lets the shell place
 * the mark on any of Oracle's charcoal surfaces without a second asset.
 */
export function OracleMark({
  className = "",
  iconOnly = false,
  size = 34,
  label = "oracle",
}: OracleMarkProps) {
  const wordmarkStyle: CSSProperties = {
    fontFamily: SERIF_STACK,
    fontOpticalSizing: "auto",
  };

  return (
    <span
      className={`inline-flex min-w-0 items-center gap-2.5 text-[#7CC4FF] ${className}`}
      aria-label={iconOnly ? label : undefined}
      role={iconOnly ? "img" : undefined}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        aria-hidden
        className="shrink-0 overflow-visible"
      >
        <path
          d="M24 3.5C32.4 8.8 38.7 15.6 44.2 24 38.7 32.4 32.4 39.2 24 44.5 15.6 39.2 9.3 32.4 3.8 24 9.3 15.6 15.6 8.8 24 3.5Z"
          stroke="currentColor"
          strokeWidth="1.15"
          opacity="0.38"
        />
        <ellipse
          cx="24"
          cy="24"
          rx="18.5"
          ry="7.4"
          stroke="currentColor"
          strokeWidth="1.25"
          opacity="0.8"
          transform="rotate(-30 24 24)"
        />
        <ellipse
          cx="24"
          cy="24"
          rx="18.5"
          ry="7.4"
          stroke="currentColor"
          strokeWidth="1.25"
          opacity="0.52"
          transform="rotate(30 24 24)"
        />
        <path
          d="M24 12.2 31.8 24 24 35.8 16.2 24 24 12.2Z"
          fill="currentColor"
          fillOpacity="0.08"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <circle cx="24" cy="24" r="3.1" fill="currentColor" />
        <circle cx="24" cy="24" r="6.4" stroke="currentColor" strokeWidth="0.8" opacity="0.28" />
      </svg>

      {!iconOnly && (
        <span
          className="truncate text-[1.7rem] font-normal leading-none tracking-[-0.035em] text-[#ECE7DA]"
          style={wordmarkStyle}
        >
          {label}
        </span>
      )}
    </span>
  );
}
