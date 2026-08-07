"use client";
import { cloneElement, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Typography } from "./typography";
import { cn } from "./cn";

/**
 * Button — vendored VERBATIM from @nous-research/ui@0.19.1
 * (dist/ui/components/button.js). `cn`/`Typography` imports rewired to local;
 * the cva variant matrix, shadow constants, and icon-slot markup are unchanged.
 * Carries no `three` weight.
 */
const SHADOW_DEFAULT = "shadow-[inset_-1px_-1px_0_0_#00000080,inset_1px_1px_0_0_#ffffff80]";
const SHADOW_INVERT = "shadow-[inset_-1px_-1px_0_0_#00000080,inset_1px_1px_0_0_#ffffff29]";
const SHADOW_INVERT_OUTLINED = "shadow-[inset_-1px_-1px_0_0_#ffffff12,inset_1px_1px_0_0_#ffffff29]";
const ACTIVE_FILTER =
  "active:[filter:invert(1)_brightness(calc(100-99*var(--foreground-alpha,0)))]";

const buttonVariants = cva(
  [
    "group relative grid cursor-pointer grid-cols-[auto_1fr_auto] items-center",
    "text-display leading-0 font-bold tracking-[0.2em]",
    "disabled:pointer-events-none disabled:bg-midground/15 disabled:text-midground disabled:shadow-none",
  ],
  {
    compoundVariants: [
      {
        class: `bg-midground text-background-base active:invert ${SHADOW_DEFAULT}`,
        destructive: false,
        ghost: false,
        invert: false,
        outlined: false,
      },
      {
        class: `bg-midground/15 text-midground ${SHADOW_INVERT} ${ACTIVE_FILTER}`,
        destructive: false,
        ghost: false,
        invert: true,
        outlined: false,
      },
      {
        class: `shadow-midground ${SHADOW_DEFAULT} ${ACTIVE_FILTER}`,
        destructive: false,
        ghost: false,
        invert: false,
        outlined: true,
      },
      {
        class: `${SHADOW_INVERT_OUTLINED} ${ACTIVE_FILTER}`,
        destructive: false,
        ghost: false,
        invert: true,
        outlined: true,
      },
      {
        class: "bg-transparent text-current hover:bg-midground/10 shadow-none",
        destructive: false,
        ghost: true,
      },
      {
        class: "bg-transparent text-destructive hover:bg-destructive/10 shadow-none",
        destructive: true,
        ghost: true,
      },
      {
        class: `bg-destructive text-destructive-foreground hover:bg-destructive/90 ${SHADOW_INVERT}`,
        destructive: true,
        ghost: false,
        outlined: false,
      },
      {
        class:
          "border border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10 shadow-none",
        destructive: true,
        ghost: false,
        outlined: true,
      },
    ],
    defaultVariants: {
      destructive: false,
      ghost: false,
      invert: false,
      outlined: false,
      size: "default",
    },
    variants: {
      destructive: { true: "" },
      ghost: { true: "" },
      invert: { true: "" },
      outlined: { true: "text-midground bg-transparent" },
      size: {
        default: "px-[.9em_.75em] py-[1.25em]",
        icon: "p-2 aspect-square grid-cols-1 place-items-center [&>svg]:size-3.5",
        sm: "px-3 py-1.5 text-[0.7rem] tracking-[0.15em] [&>svg]:size-3",
        xs: "p-1 aspect-square grid-cols-1 place-items-center [&>svg]:size-3",
      },
    },
  },
);

const IconSlot = ({ icon, side }: { icon: ReactNode; side: "left" | "right" }) => (
  <>
    <span className="w-5" />
    <span
      className={cn("absolute top-1/2 -translate-y-1/2", side === "left" ? "left-3" : "right-3")}
    >
      {typeof icon === "object" && icon !== null
        ? cloneElement(icon as React.ReactElement<{ className?: string }>, {
            className: "size-3.5",
          })
        : icon}
    </span>
  </>
);

interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "prefix" | "suffix">,
    VariantProps<typeof buttonVariants> {
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export const Button = ({
  children,
  className,
  destructive,
  ghost,
  invert,
  outlined,
  prefix,
  size,
  suffix,
  ...props
}: ButtonProps) => (
  <Typography
    as="button"
    className={cn(buttonVariants({ destructive, ghost, invert, outlined, size }), className)}
    mono
    {...props}
  >
    {!ghost && (
      <span
        aria-hidden
        className="arc-border opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100"
      />
    )}
    {prefix && <IconSlot icon={prefix} side="left" />}
    {children}
    {suffix && <IconSlot icon={suffix} side="right" />}
  </Typography>
);
