"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import {
  Dialog,
  ResponsiveDialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ResearchBriefingView } from "@/components/ResearchBriefing";

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
        <ResponsiveDialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <DialogHeader className="border-b border-slate-800 pb-3">
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
                <Search className="size-3.5" />
              </span>
              <span>
                AI research
                <span className="block text-xs font-normal text-slate-400">{name}</span>
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="pt-1">
            <ResearchBriefingView text={summary} />
          </div>
        </ResponsiveDialogContent>
      </Dialog>
    </>
  );
}
