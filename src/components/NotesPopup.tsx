"use client";

import { useState } from "react";
import { Pin } from "lucide-react";
import {
  Dialog,
  ResponsiveDialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** One PINNED note to surface on a card. */
export type PinnedNote = {
  /** Where it came from — "Pinned lead note" / "Pinned contact note" / "Pinned note". */
  label: string;
  text: string;
};

/**
 * Pin icon on a kanban tile, shown ONLY when a note has actually been PINNED —
 * i.e. a TimelinePin row exists for it. Merely having a note is not enough: the
 * pin is the signal a user deliberately raised, and almost every lead has some
 * note, so keying off note text made the icon meaningless.
 *
 * Hovering previews the pinned notes (clamped); clicking opens them in full,
 * since hover does not exist on touch. Pointer events are stopped so neither
 * gesture starts a card drag.
 */
export default function NotesPopup({
  notes,
  name,
}: {
  notes: PinnedNote[];
  name: string;
}) {
  const [open, setOpen] = useState(false);

  const sections = notes.filter((note) => note.text.trim());
  if (sections.length === 0) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setOpen(true);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="flex shrink-0 items-center rounded p-0.5 text-orange-300 transition-colors hover:bg-orange-500/15"
            aria-label={
              sections.length === 1 ? "Pinned note" : `${sections.length} pinned notes`
            }
          >
            <Pin className="size-3.5 fill-current" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          className="max-w-xs space-y-2 p-3 text-left"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {sections.map((section, index) => (
            <div key={`${section.label}-${index}`}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {section.label}
              </p>
              <p className="mt-0.5 line-clamp-6 whitespace-pre-wrap text-xs leading-relaxed text-popover-foreground">
                {section.text}
              </p>
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground">Click to read in full</p>
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <ResponsiveDialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pin className="size-4 fill-current text-primary" />
              Pinned notes — {name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {sections.map((section, index) => (
              <div key={`${section.label}-${index}`}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.label}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                  {section.text}
                </p>
              </div>
            ))}
          </div>
        </ResponsiveDialogContent>
      </Dialog>
    </>
  );
}
