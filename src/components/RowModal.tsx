"use client";

import { useEffect, useState, type ReactNode } from "react";

/** A clickable list row that opens its content in an overlay modal. */
export default function RowModal({ row, children }: { row: ReactNode; children: ReactNode }) {
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full text-left px-4 py-3 hover:bg-slate-800/50 transition-colors cursor-pointer"
      >
        {row}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-10 overflow-y-auto"
          onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="w-full max-w-2xl pb-10">
            <div className="flex justify-end mb-2">
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
