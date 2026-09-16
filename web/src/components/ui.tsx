import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-accent px-4 py-2 text-[#07110c] hover:bg-[#8cebb8]",
        outline: "border border-border bg-transparent px-4 py-2 hover:bg-white/5",
        ghost: "px-3 py-2 text-muted hover:bg-white/5 hover:text-foreground",
        destructive: "border border-red-500/40 bg-red-500/10 px-4 py-2 text-red-300 hover:bg-red-500/20",
      },
      size: {
        default: "h-10",
        sm: "h-8 text-xs",
        lg: "h-12 px-5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-border bg-panel shadow-glow", className)} {...props} />;
}

export function Badge({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", className)}
      {...props}
    />
  );
}
