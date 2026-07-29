"use client";

import { type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useSavePending } from "@/components/SaveForm";

/**
 * A design-system <Button> that shows the enclosing <SaveForm>'s pending state.
 *
 * SaveButton renders a bare <button>, which is right where the markup already
 * used one. Some surfaces use the shadcn Button for its variants, and swapping
 * those for a bare button to gain pending feedback would trade one regression
 * for another. This keeps the variant styling and adds the pending behaviour.
 */
export function SaveSubmitButton({
  children,
  pendingLabel = "Saving…",
  disabled,
  ...rest
}: { children: ReactNode; pendingLabel?: string } & Omit<
  ComponentProps<typeof Button>,
  "type" | "children"
>) {
  const pending = useSavePending();
  return (
    <Button {...rest} type="submit" disabled={pending || disabled} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
