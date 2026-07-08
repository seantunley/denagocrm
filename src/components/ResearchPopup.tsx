"use client";

import { useState } from "react";

/**
 * 🔎 icon on a kanban tile: opens a popup with the lead's AI research
 * summary. Click is stopped from bubbling so it never starts a card drag.
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
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen(true);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="shrink-0 text-sm leading-none rounded-md px-1 py-0.5 hover:bg-slate-700/70 transition-colors cursor-pointer"
        title="AI research — click to read"
        aria-label="AI research"
      >
        🔎
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            className="card w-full max-w-2xl p-0 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <p className="text-sm font-semibold text-slate-200">🔎 Research · {name}</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-white text-lg leading-none cursor-pointer"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="p-5 max-h-[85vh] overflow-y-auto">
              <p className="text-sm whitespace-pre-wrap leading-relaxed text-slate-200">
                {summary}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
