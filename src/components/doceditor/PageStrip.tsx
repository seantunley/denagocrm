"use client";

import { useDeferredValue, useMemo } from "react";
import { useEditor } from "@/lib/doceditor/store";
import { previewContext, renderSigningSheets } from "@/lib/doceditor/serialize";
import { COMPANY_DEFAULTS } from "@/lib/companyBrand";
import { useDocEditorEnv } from "./EditorContext";

const THUMB = 92; // px wide

/**
 * Every page of the document, small, down the side: where you are, and one
 * click to anywhere else. Each thumbnail is the page as the print renderer
 * draws it (the signing sheet), scaled down — our own escaped markup.
 *
 * Drawn from a deferred copy of the document, so typing on the page is never
 * held up waiting for the thumbnails to catch up.
 */
export function PageStrip() {
  const doc = useEditor((s) => s.doc);
  const activePage = useEditor((s) => s.activePage);
  const setActivePage = useEditor((s) => s.setActivePage);
  const { logoSrc, companyName, company } = useDocEditorEnv();
  const settled = useDeferredValue(doc);
  const sheets = useMemo(
    () => (settled ? renderSigningSheets(settled, previewContext({ company: { ...COMPANY_DEFAULTS, ...company, name: company?.name || companyName || COMPANY_DEFAULTS.name }, logo: logoSrc || undefined })) : null),
    [settled, company, companyName, logoSrc],
  );
  if (!doc || !sheets) return null;
  const scale = THUMB / sheets.width;
  const go = (i: number) => {
    setActivePage(i);
    document.querySelector(`[data-page-idx="${i}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <nav aria-label="Pages" className="hidden w-[124px] flex-shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-100 p-3 md:block">
      <style>{sheets.css}</style>
      <ol className="space-y-3">
        {sheets.pages.map((html, i) => (
          <li key={i}>
            {/* A div, not a <button>: a page holds tables and links, which a button may not contain. */}
            <div
              role="button" tabIndex={0} onClick={() => go(i)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(i); } }}
              aria-current={activePage === i ? "page" : undefined} aria-label={`Go to page ${i + 1}`}
              className={`block w-full cursor-pointer rounded-sm bg-white shadow-sm ring-1 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${activePage === i ? "ring-2 ring-orange-400" : "ring-black/10 hover:ring-slate-400"}`}
              style={{ height: sheets.height * scale, overflow: "hidden", position: "relative" }}
            >
              {/* The page at its real size, scaled: nothing inside it can be clicked or focused. */}
              <div aria-hidden inert className="sg-sheet pointer-events-none" style={{ width: sheets.width, height: sheets.height, transform: `scale(${scale})`, transformOrigin: "top left", position: "absolute", top: 0, left: 0, background: "#fff" }} dangerouslySetInnerHTML={{ __html: html }} />
            </div>
            <div className={`mt-1 text-center text-[10px] ${activePage === i ? "font-semibold text-orange-600" : "text-slate-500"}`}>{i + 1}</div>
          </li>
        ))}
      </ol>
    </nav>
  );
}
