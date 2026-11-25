"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, X } from "lucide-react";
import ContactComposer, { type ContactComposerProps } from "@/components/records/ContactComposer";

/**
 * One Today row that DOES its action (lib/todayAction.ts). The button opens the
 * composer (components/records/ContactComposer.tsx — the same one the record drawer
 * uses) under the row with the deal's context filled in; one more click logs or
 * sends, books the next step and takes the row off the list. Every write goes
 * through the existing actions, so their permission checks and send guards all
 * still apply. Nothing is sent until the rep presses the button.
 */
export default function TodayRow({
  action,
  children,
  ...composer
}: Omit<ContactComposerProps, "revalidate" | "onDone" | "onCancel"> & { action: string; children: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);

  if (done) return null;
  const id = `today-${composer.leadId}`;
  return (
    <li className="card space-y-3" data-record-open={`lead:${composer.leadId}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {children}
        <button
          type="button"
          className="btn-primary btn-sm shrink-0"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {action}
          {open ? <X className="size-4" /> : <ArrowRight className="size-4" />}
        </button>
      </div>

      {open && (
        <div id={id}>
          <ContactComposer
            {...composer}
            revalidate="/today"
            onCancel={() => setOpen(false)}
            onDone={() => {
              setDone(true);
              router.refresh();
            }}
          />
        </div>
      )}
    </li>
  );
}
