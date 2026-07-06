"use client";

import { useState } from "react";

/**
 * Standard destructive-action guard: warning popup + mandatory reason.
 * `action` receives the form data (field "reason").
 */
export default function ConfirmDelete({
  action,
  title,
  description,
  trigger = "Delete",
  triggerClass = "btn-danger",
  confirmLabel = "Delete",
}: {
  action: (formData: FormData) => Promise<void>;
  title: string;
  description?: string;
  trigger?: string;
  triggerClass?: string;
  confirmLabel?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={triggerClass} title={title}>
        {trigger}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="card w-full max-w-md border-red-900/60">
            <div className="flex items-start gap-3 mb-3">
              <span className="text-2xl">⚠️</span>
              <div>
                <h2 className="font-bold text-white">{title}</h2>
                <p className="text-sm text-slate-400 mt-1">
                  {description ??
                    "This item will move to the Trash and be permanently removed after 60 days."}
                </p>
              </div>
            </div>
            <form action={action} className="space-y-3">
              <div>
                <label className="label">Reason for deleting *</label>
                <textarea
                  name="reason"
                  className="input"
                  rows={2}
                  required
                  placeholder="e.g. Duplicate entry / created by mistake"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-danger">
                  {confirmLabel}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
