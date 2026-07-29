"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * Toasts are colour-coded by outcome: green for a save that landed, red for one
 * that did not.
 *
 * Every toast used to share the neutral popover styling, so a success and a
 * failure were distinguishable only by a small icon — the single glance a toast
 * gets is exactly when that is easiest to miss.
 *
 * `richColors` is what makes Sonner read the per-type variables below. The values
 * deliberately reuse the tint the rest of the app already uses for these two
 * meanings (`bg-emerald-500/15 text-emerald-300` and `bg-red-500/15
 * text-red-300` on badges and status pills), so a toast reads as the same
 * language rather than a second colour scheme.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      richColors
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",

          // Mixed against the popover background rather than set as flat colours,
          // so the panel keeps its depth and stays legible if the surface changes.
          "--success-bg": "color-mix(in oklab, var(--color-emerald-500) 15%, var(--popover))",
          "--success-border": "color-mix(in oklab, var(--color-emerald-500) 32%, var(--border))",
          "--success-text": "var(--color-emerald-300)",

          "--error-bg": "color-mix(in oklab, var(--color-red-500) 15%, var(--popover))",
          "--error-border": "color-mix(in oklab, var(--color-red-500) 32%, var(--border))",
          "--error-text": "var(--color-red-300)",

          "--warning-bg": "color-mix(in oklab, var(--color-amber-500) 15%, var(--popover))",
          "--warning-border": "color-mix(in oklab, var(--color-amber-500) 32%, var(--border))",
          "--warning-text": "var(--color-amber-200)",

          "--info-bg": "var(--popover)",
          "--info-border": "var(--border)",
          "--info-text": "var(--popover-foreground)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
