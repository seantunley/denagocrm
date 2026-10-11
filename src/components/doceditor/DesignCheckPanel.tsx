"use client";

import { useState } from "react";
import { useEditor } from "@/lib/doceditor/store";
import { summariseWarnings, type DesignWarning } from "@/lib/doceditor/designCheck";

/**
 * The design check, in the editor: one quiet line when there is something to
 * look at, opening to the list. Each finding has a "Show" button that selects
 * the block or field it is about and scrolls the page to it — a warning you
 * have to go hunting for is a warning that gets ignored.
 *
 * It never blocks saving or publishing. Every finding can be a deliberate choice.
 */
export function DesignCheckPanel({ warnings }: { warnings: DesignWarning[] }) {
  const [open, setOpen] = useState(false);
  const select = useEditor((s) => s.select);
  const selectField = useEditor((s) => s.selectField);
  const setActivePage = useEditor((s) => s.setActivePage);
  if (warnings.length === 0) return null;

  const show = (w: DesignWarning) => {
    setActivePage(w.page - 1);
    if (w.fieldId) selectField(w.fieldId);
    else if (w.blockId) select(w.blockId);
    // After the selection has rendered: bring it — or at least its page — into view.
    requestAnimationFrame(() => {
      const target =
        (w.fieldId && document.querySelector(`[data-field-id="${CSS.escape(w.fieldId)}"]`)) ||
        (w.blockId && document.querySelector(`[data-block-id="${CSS.escape(w.blockId)}"]`)) ||
        document.querySelector(`[data-page-idx="${w.page - 1}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <div role="status" className="border-b border-sky-200 bg-sky-50 text-xs text-sky-950">
      <button type="button" className="flex w-full items-center gap-2 px-4 py-2 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="font-semibold">Design check</span>
        <span>{summariseWarnings(warnings)}</span>
        <span className="ml-auto text-sky-700">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <ul className="max-h-48 space-y-1 overflow-y-auto px-4 pb-2">
          {warnings.map((w, i) => (
            <li key={`${w.code}-${w.fieldId ?? w.blockId ?? w.page}-${i}`} className="flex items-start gap-2">
              <span className="flex-1">{w.message}</span>
              <button type="button" className="shrink-0 rounded border border-sky-300 bg-white px-1.5 py-0.5 text-[11px] text-sky-800 hover:bg-sky-100" onClick={() => show(w)}>Show</button>
            </li>
          ))}
          <li className="pt-1 text-[11px] text-sky-800/80">These are things to check, not errors — you can save and publish regardless. Not checked: image sharpness and colour contrast.</li>
        </ul>
      )}
    </div>
  );
}
