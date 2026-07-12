"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Research icon on a kanban tile: opens the lead's AI research summary in the
 * standard dialog. Pointer events are stopped so it never starts a card drag.
 */
export default function ResearchPopup({
  summary,
  name,
}: {
  summary: string;
  name: string;
}) {
  const [open, setOpen] = useState(false);

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
            className="flex shrink-0 items-center rounded p-0.5 text-sky-300 transition-colors hover:bg-sky-500/15"
            aria-label="AI research"
          >
            <Search className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>AI research — click to read</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Search className="size-4 text-primary" />
              Research — {name}
            </DialogTitle>
          </DialogHeader>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {summary}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
