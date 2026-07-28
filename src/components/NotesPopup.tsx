"use client";

import { useState } from "react";
import { StickyNote } from "lucide-react";
import {
  Dialog,
  ResponsiveDialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type LinkedNotes = {
  lead: string | null;
  contact: string | null;
};

/**
 * Notes icon on a kanban tile: hovering previews the lead's and/or the linked
 * contact's note, clicking opens the full text (the preview is clamped, and
 * hover doesn't exist on touch). Pointer events are stopped so neither the
 * hover nor the click ever starts a card drag.
 */
export default function NotesPopup({
  notes,
  name,
}: {
  notes: LinkedNotes;
  name: string;
}) {
  const [open, setOpen] = useState(false);

  const sections = [
    { label: "Lead note", text: notes.lead },
    { label: "Contact note", text: notes.contact },
  ].filter((section): section is { label: string; text: string } =>
    Boolean(section.text?.trim()),
  );

  if (sections.length === 0) return null;

  const label = sections.length > 1 ? "Lead & contact notes" : sections[0].label;

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
            className="flex shrink-0 items-center rounded p-0.5 text-amber-300 transition-colors hover:bg-amber-500/15"
            aria-label={label}
          >
            <StickyNote className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          className="max-w-xs space-y-2 p-3 text-left"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {sections.map((section) => (
            <div key={section.label}>
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
              <StickyNote className="size-4 text-primary" />
              Notes — {name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {sections.map((section) => (
              <div key={section.label}>
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
