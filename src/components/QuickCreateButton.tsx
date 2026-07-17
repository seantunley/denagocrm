"use client";

import type {
  ButtonHTMLAttributes,
  MouseEvent,
  ReactNode,
} from "react";
import {
  openQuickCreate,
  type QuickCreateKind,
} from "@/components/QuickCreateDialog";

export function QuickCreateButton({
  kind,
  children,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind: QuickCreateKind;
  children: ReactNode;
}) {
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    onClick?.(event);
    if (!event.defaultPrevented) openQuickCreate(kind);
  }

  return (
    <button {...props} type="button" onClick={handleClick}>
      {children}
    </button>
  );
}
