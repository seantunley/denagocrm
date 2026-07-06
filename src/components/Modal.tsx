"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Standard capture-form popup. The trigger button opens an overlay modal;
 * `children` (usually a form) is server-rendered and passed in as a slot.
 */
export default function ModalTrigger({
  label,
  title,
  buttonClass = "btn-primary",
  children,
}: {
  label: string;
  title: string;
  buttonClass?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button onClick={() => setOpen(true)} className={buttonClass}>
        {label}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-10 overflow-y-auto"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="w-full max-w-2xl pb-10">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xl font-bold text-white">{title}</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-white text-2xl leading-none cursor-pointer"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {children}
          </div>
        </div>
      )}
    </>
  );
}
