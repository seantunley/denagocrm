"use client";

import { CalendarX2 } from "lucide-react";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";

export function AvailabilityConflictDialog({
  message,
  onClose,
  title = "Calendar conflict",
}: {
  message: string | null;
  onClose: () => void;
  title?: string;
}) {
  return (
    <Dialog open={Boolean(message)} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <div className="mb-2 grid size-10 place-items-center rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-300">
            <CalendarX2 className="size-5" />
          </div>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="pt-1 text-sm leading-6">
            {message}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end pt-2">
          <button type="button" className="btn-primary" onClick={onClose}>
            Choose another time
          </button>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
