"use client";

import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "Add more detail" on a create form: a toggle, and the folded fields.
 *
 * The fields are HIDDEN, not unmounted. Anything typed into them survives a
 * fold, and a hidden `<select>` still posts its default — so the server action
 * receives exactly the same FormData whether or not the section is open.
 */
export function FormDetailDisclosure({
  expanded,
  onToggle,
  label = "Add more detail",
  collapseLabel = "Fewer fields",
  hint,
  children,
}: {
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  label?: string;
  collapseLabel?: string;
  /** What is folded away, shown beside the toggle while it is collapsed. */
  hint?: string;
  children: ReactNode;
}) {
  const panelId = useId();
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          className="btn-secondary"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => onToggle(!expanded)}
        >
          <ChevronDown className={cn("size-4 transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
          {expanded ? collapseLabel : label}
        </button>
        {!expanded && hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div id={panelId} hidden={!expanded} className="space-y-4">
        {children}
      </div>
    </>
  );
}
