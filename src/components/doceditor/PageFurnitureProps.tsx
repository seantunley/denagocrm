"use client";

import { useEditor } from "@/lib/doceditor/store";
import type { DocumentBlock, DocumentModel } from "@/lib/doceditor/model";
import { MIN_RUNNING_MARGIN } from "@/lib/doceditor/pageFurniture";

const lbl = "block text-[11px] font-medium text-slate-500 mb-1";
const inp = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none";
const check = "flex items-center gap-2 text-sm text-slate-700";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-slate-100 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      {children}
    </div>
  );
}

type Running = NonNullable<DocumentModel["running"]>;
const BLANK: Running = { header: { left: "", centre: "", right: "" }, footer: { left: "", centre: "", right: "" }, skipFirst: false };
const SLOTS = ["left", "centre", "right"] as const;
const PAGE_OF = "Page {{page}} of {{pages}}";

/** The document's running header and footer: a line at the top and foot of every printed sheet. */
export function RunningSection() {
  const running = useEditor((s) => s.doc?.running) ?? BLANK;
  const margin = useEditor((s) => s.doc?.style.margin ?? 0);
  const commit = useEditor((s) => s.commit);
  // A document whose lines are all blank carries no setting at all — it is exactly a document that never had one.
  const save = (next: Running) => commit((d) => {
    const blank = [next.header, next.footer].every((line) => SLOTS.every((slot) => !line[slot].trim()));
    if (!blank) return { ...d, running: next };
    const { running: _gone, ...rest } = d;
    void _gone;
    return rest;
  });
  const line = (which: "header" | "footer", title: string) => (
    <div className="mb-3">
      <label className={lbl}>{title}</label>
      <div className="grid grid-cols-3 gap-1">
        {SLOTS.map((slot) => (
          <input key={slot} className={inp} aria-label={`${title}, ${slot}`} placeholder={slot === "centre" ? "Centre" : slot === "left" ? "Left" : "Right"} value={running[which][slot]} onChange={(e) => save({ ...running, [which]: { ...running[which], [slot]: e.target.value } })} />
        ))}
      </div>
    </div>
  );
  const used = [running.header, running.footer].some((l) => SLOTS.some((slot) => l[slot].trim()));
  return (
    <Section title="Header & footer on every page">
      {line("header", "Top of each page")}
      {line("footer", "Foot of each page")}
      <div className="mb-3 flex flex-wrap gap-1">
        <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" onClick={() => save({ ...running, footer: { ...running.footer, centre: PAGE_OF } })}>＋ Page 1 of 3</button>
        <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" onClick={() => save({ ...running, footer: { ...running.footer, left: "{{company.name}}" } })}>＋ Company name</button>
        <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" onClick={() => save({ ...running, header: { ...running.header, right: "{{quote.number}}" } })}>＋ Quote number</button>
      </div>
      <label className={check}><input type="checkbox" checked={running.skipFirst} disabled={!used} onChange={(e) => save({ ...running, skipFirst: e.target.checked })} /> Not on the first page (a cover)</label>
      {used && margin < MIN_RUNNING_MARGIN ? (
        <p className="mt-2 text-[11px] text-amber-600">These are set in the page margin, and this document&apos;s margin is {margin}px. Give it at least {MIN_RUNNING_MARGIN}px (Document → Margin) or they will not print.</p>
      ) : (
        <p className="mt-2 text-[11px] text-slate-400">Set in the page margin, on every printed sheet. <code>{"{{page}}"}</code> and <code>{"{{pages}}"}</code> are the page number and the number of pages; other merge fields work too.</p>
      )}
    </Section>
  );
}

/**
 * The page being worked on: a margin of its own, in place of the document's —
 * a cover that runs to the edge of the paper, a letter page with wide margins.
 */
export function PageSection() {
  const doc = useEditor((s) => s.doc);
  const activePage = useEditor((s) => s.activePage);
  const commit = useEditor((s) => s.commit);
  if (!doc) return null;
  const index = Math.min(activePage, doc.pages.length - 1);
  const page = doc.pages[index];
  const own = page.margin !== undefined;
  const setMargin = (margin: number | undefined) => commit((d) => ({
    ...d,
    pages: d.pages.map((p) => {
      if (p.id !== page.id) return p;
      const { margin: _old, ...rest } = p;
      void _old;
      return margin === undefined ? rest : { ...rest, margin };
    }),
  }));
  return (
    <Section title={`Page ${index + 1}${doc.pages.length > 1 ? ` of ${doc.pages.length}` : ""}`}>
      <label className={check}><input type="checkbox" checked={own} onChange={(e) => setMargin(e.target.checked ? doc.style.margin : undefined)} /> A margin of its own</label>
      {own && (
        <div className="mt-2"><label className={lbl}>This page&apos;s margin ({page.margin}px)</label><input type="range" min={0} max={120} className="w-full" value={page.margin} onChange={(e) => setMargin(Number(e.target.value))} /></div>
      )}
      <p className="mt-2 text-[11px] text-slate-400">
        {own
          ? "Text and blocks in rows move with the margin. Anything placed by hand — a freely placed block, a signing field — stays where it is on the sheet."
          : `Uses the document's margin (${doc.style.margin}px). Click a page to choose which one this is.`}
      </p>
    </Section>
  );
}

/** The row a flowed block sits in: the gap between its columns, and what it does at a page break. */
export function RowSection({ block }: { block: DocumentBlock }) {
  const row = useEditor((s) => s.doc?.pages.flatMap((p) => p.rows).find((r) => r.columns.some((c) => c.blocks.some((b) => b.id === block.id))));
  const updateRow = useEditor((s) => s.updateRow);
  if (!row) return null;
  const gap = row.settings?.gap ?? 16;
  return (
    <Section title="Its row">
      {row.columns.length > 1 && (
        <div className="mb-3"><label className={lbl}>Space between its {row.columns.length} columns ({gap}px)</label><input type="range" min={0} max={48} step={2} className="w-full" value={gap} onChange={(e) => updateRow(row.id, { gap: Number(e.target.value) })} /></div>
      )}
      <div className="space-y-1.5">
        <label className={check}><input type="checkbox" checked={!!row.settings?.keepTogether} onChange={(e) => updateRow(row.id, { keepTogether: e.target.checked })} /> Never split this row across two pages</label>
        <label className={check}><input type="checkbox" checked={!!row.settings?.keepWithNext} onChange={(e) => updateRow(row.id, { keepWithNext: e.target.checked })} /> Keep with the row after it</label>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">For content that runs onto another page: keep a heading with what it heads, or a signature block in one piece.</p>
    </Section>
  );
}
