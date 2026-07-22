"use client";

import { clearSecret } from "@/app/actions/settings";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";

/**
 * Owner-only "Clear" for a stored secret — the deliberate way to disconnect an
 * integration or remove a compromised key (a blank save only "keeps" now). Uses
 * the app Dialog to confirm (the repo's visual guardrail rejects native
 * window.confirm). The trigger is a non-submit button so it never submits the
 * surrounding settings form, and the confirm form is portaled out of that form by
 * the dialog — so there's no nested <form>. The server action re-checks owner +
 * an allowlisted key.
 */
export default function ClearSecret({ settingKey, label }: { settingKey: string; label: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="btn-secondary" title={`Clear ${label}`}>
          Clear
        </button>
      </DialogTrigger>
      <ResponsiveDialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>Clear the {label}?</DialogTitle>
          <DialogDescription>
            The integration stops working until a new value is saved. You can re-enter it any time.
          </DialogDescription>
        </DialogHeader>
        <form action={clearSecret.bind(null, settingKey)} className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose asChild>
            <button type="button" className="btn-secondary">Cancel</button>
          </DialogClose>
          <button type="submit" className="btn-danger">Clear</button>
        </form>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
