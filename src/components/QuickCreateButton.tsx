"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  openQuickCreate,
  type QuickCreateKind,
} from "@/components/QuickCreateDialog";

export function QuickCreateButton({
  kind,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind: QuickCreateKind;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={() => openQuickCreate(kind)} {...props}>
      {children}
    </button>
  );
}
