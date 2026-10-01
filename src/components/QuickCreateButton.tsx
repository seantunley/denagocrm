"use client";

import type {
  ButtonHTMLAttributes,
  MouseEvent,
  ReactNode,
} from "react";
import {
  openQuickCreate,
  type QuickCreateDefaults,
  type QuickCreateKind,
} from "@/components/QuickCreateDialog";

export function QuickCreateButton({
  kind,
  defaults,
  children,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind: QuickCreateKind;
  /** Pre-fills the dialog — e.g. the customer when opened from their page. */
  defaults?: QuickCreateDefaults;
  children: ReactNode;
}) {
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    onClick?.(event);
    if (!event.defaultPrevented) openQuickCreate(kind, defaults);
  }

  return (
    <button {...props} type="button" onClick={handleClick}>
      {children}
    </button>
  );
}
