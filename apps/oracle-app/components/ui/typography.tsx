"use client";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

/**
 * Typography — vendored VERBATIM from @nous-research/ui@0.19.1
 * (dist/ui/components/typography/index.js). Only the `cn`/`polyRef` imports are
 * rewired to local equivalents (polyRef === React.forwardRef) so the component
 * carries zero `three` weight. The font/variant class strings are unchanged.
 */
const typographyVariants = cva("font-sans", {
  variants: {
    compressed: { true: "font-compressed" },
    courier: { true: "font-courier" },
    expanded: { true: "font-expanded" },
    mondwest: { true: "font-mondwest tracking-[0.1875rem]" },
    mono: { true: "font-mono" },
    sans: { true: "font-sans" },
    variant: {
      lg: "text-[2.625rem] leading-[1] tracking-[0.0525rem]",
      md: "text-[2.625rem] leading-[1] tracking-[0.0525rem]",
      sm: "leading-1.4 text-[.9375rem] tracking-[0.1875rem]",
      xl: "text-[4.5rem] leading-[1] tracking-[0.135rem]",
    },
  },
});

export type TypographyProps<T extends React.ElementType = "span"> = {
  as?: T;
  className?: string;
  compressed?: boolean;
  courier?: boolean;
  expanded?: boolean;
  mondwest?: boolean;
  mono?: boolean;
  variant?: "lg" | "md" | "sm" | "xl";
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className"> &
  VariantProps<typeof typographyVariants>;

// Loose props for the runtime forwardRef. The official package uses `polyRef`
// (a polymorphic forwardRef whose typing erases the element-specific generic);
// we mirror that by accepting any ElementType here, while the generic
// `TypographyProps<T>` export above gives consumers (Progress `barProps`, etc.)
// element-aware prop inference.
interface TypographyRuntimeProps {
  as?: React.ElementType;
  className?: string;
  compressed?: boolean;
  courier?: boolean;
  expanded?: boolean;
  mondwest?: boolean;
  mono?: boolean;
  variant?: "lg" | "md" | "sm" | "xl";
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export const Typography = forwardRef<HTMLElement, TypographyRuntimeProps>(function Typography(
  { as, className, compressed, courier, expanded, mondwest, mono, variant, ...rest },
  ref,
) {
  const fonts = { compressed, courier, expanded, mondwest, mono };
  const fontVariant = { ...fonts, sans: !Object.values(fonts).some(Boolean) };
  const Component = (as ?? "span") as React.ElementType;
  return (
    <Component
      {...rest}
      className={cn(typographyVariants({ ...fontVariant, variant }), className)}
      ref={ref}
    />
  );
});
