"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  BookMarked,
  Braces,
  Check,
  Eye,
  EyeOff,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Redo2,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { MergeFieldDef } from "@/lib/mergeFields";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/shadcn/style.css";

const BlockNoteInner = dynamic(() => import("./StudioEditorInner"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-500">
      <Loader2 className="size-4 animate-spin" /> Loading editor…
    </div>
  ),
});

export type Clause = { id: string; name: string; category: string | null; contentJson: unknown };
type EditorApi = {
  insertToken: (token: string) => void;
  insertBlocks: (blocks: unknown) => void;
  undo: () => void;
  redo: () => void;
};

export default function StudioEditor({
  initialTitle,
  initialContent,
  fields,
  clauses,
  readOnly = false,
  onSave,
  headerRight,
}: {
  initialTitle: string;
  initialContent: unknown;
  fields: MergeFieldDef[];
  clauses: Clause[];
  readOnly?: boolean;
  onSave: (data: { title: string; content: unknown }) => Promise<{ ok: boolean; error?: string }>;
  headerRight?: React.ReactNode;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [status, setStatus] = useState<"saved" | "saving" | "dirty">("saved");
  const [preview, setPreview] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const contentRef = useRef<unknown>(initialContent);
  const editorApi = useRef<EditorApi | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const groups = useMemo(() => {
    const grouped = new Map<string, MergeFieldDef[]>();
    for (const field of fields) grouped.set(field.group, [...(grouped.get(field.group) ?? []), field]);
    return [...grouped.entries()];
  }, [fields]);

  function scheduleSave(nextTitle = title) {
    if (readOnly) return;
    setStatus("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setStatus("saving");
      const result = await onSave({ title: nextTitle, content: contentRef.current }).catch(() => ({
        ok: false as const,
        error: "Save failed",
      }));
      if (result.ok) setStatus("saved");
      else {
        setStatus("dirty");
        toast.error(result.error ?? "Couldn’t save document");
      }
    }, 1200);
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-[#0d1110] shadow-[0_24px_80px_rgba(0,0,0,.28)]",
        fullscreen && "fixed inset-0 z-[70] rounded-none",
      )}
    >
      <div className="flex min-h-16 flex-wrap items-center gap-2 border-b border-white/[0.08] bg-[#111614] px-3 py-2.5 sm:px-4">
        <input
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            scheduleSave(event.target.value);
          }}
          readOnly={readOnly}
          aria-label="Document title"
          className="min-w-40 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-base font-semibold text-white outline-none transition-colors hover:border-white/10 focus:border-primary/50 sm:text-lg"
        />

        <SaveIndicator status={status} readOnly={readOnly} />

        {!readOnly && (
          <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.035] p-0.5">
            <ToolbarButton label="Undo" onClick={() => editorApi.current?.undo()}><Undo2 className="size-4" /></ToolbarButton>
            <ToolbarButton label="Redo" onClick={() => editorApi.current?.redo()}><Redo2 className="size-4" /></ToolbarButton>
          </div>
        )}

        <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.035] p-0.5">
          <ToolbarButton label={preview ? "Edit document" : "Preview document"} active={preview} onClick={() => setPreview((value) => !value)}>
            {preview ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </ToolbarButton>
          {!readOnly && (
            <ToolbarButton label={toolsOpen ? "Hide insert tools" : "Show insert tools"} active={toolsOpen} onClick={() => setToolsOpen((value) => !value)}>
              {toolsOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            </ToolbarButton>
          )}
          <ToolbarButton label={fullscreen ? "Exit full screen" : "Full screen"} onClick={() => setFullscreen((value) => !value)}>
            {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </ToolbarButton>
        </div>
        {headerRight && <div className="flex items-center">{headerRight}</div>}
      </div>

      <div className={cn("relative grid min-h-[65vh]", toolsOpen && !readOnly ? "md:grid-cols-[minmax(0,1fr)_19rem]" : "grid-cols-1")}>
        <main className="min-w-0 overflow-auto bg-[#171c1a] p-2 sm:p-5">
          <div className="document-canvas mx-auto min-h-[65vh] max-w-[880px] overflow-hidden rounded-xl bg-white shadow-[0_22px_65px_rgba(0,0,0,.35)] ring-1 ring-black/10">
            <BlockNoteInner
              initialContent={initialContent}
              readOnly={readOnly || preview}
              onChange={(content) => {
                contentRef.current = content;
                scheduleSave();
              }}
              registerApi={(api) => (editorApi.current = api)}
            />
          </div>
        </main>

        {toolsOpen && !readOnly && (
          <aside
            role="complementary"
            aria-label="Document insert tools"
            className="max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-[80] max-md:max-h-[72dvh] max-md:overflow-y-auto max-md:rounded-t-3xl max-md:border-t max-md:shadow-[0_-24px_70px_rgba(0,0,0,.55)] md:border-l md:border-white/[0.08]"
          >
            <div className="sticky top-0 flex items-center justify-between border-b border-white/[0.08] bg-[#111614]/95 px-4 py-3 backdrop-blur">
              <div><p className="text-sm font-semibold text-white">Insert tools</p><p className="text-xs text-slate-400">Fields and reusable clauses</p></div>
              <button type="button" onClick={() => setToolsOpen(false)} className="grid size-9 place-items-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-white"><X className="size-4" /><span className="sr-only">Close tools</span></button>
            </div>
            <div className="space-y-5 bg-[#111614] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {groups.map(([group, definitions]) => (
                <section key={group}>
                  <h3 className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400"><Braces className="size-3.5 text-primary" />{group}</h3>
                  <div className="grid gap-1.5">
                    {definitions.map((field) => (
                      <button key={field.key} type="button" onClick={() => editorApi.current?.insertToken(`{{${field.key}}}`)} className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-left text-xs text-slate-200 transition hover:border-primary/30 hover:bg-primary/5">
                        <span>{field.label}</span><code className="text-[9px] text-slate-400">{field.key}</code>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {clauses.length > 0 && (
                <section>
                  <h3 className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400"><BookMarked className="size-3.5 text-primary" />Reusable clauses</h3>
                  <div className="grid gap-1.5">
                    {clauses.map((clause) => (
                      <button key={clause.id} type="button" onClick={() => editorApi.current?.insertBlocks(clause.contentJson)} className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-left transition hover:border-primary/30 hover:bg-primary/5">
                        <span className="block text-xs font-medium text-slate-200">{clause.name}</span>{clause.category && <span className="mt-0.5 block text-[10px] text-slate-400">{clause.category}</span>}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({ label, active = false, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" title={label} aria-label={label} aria-pressed={active || undefined} onClick={onClick} className={cn("grid size-8 place-items-center rounded-md text-slate-400 transition hover:bg-white/7 hover:text-white", active && "bg-primary/15 text-primary")}>{children}</button>;
}

function SaveIndicator({ status, readOnly }: { status: "saved" | "saving" | "dirty"; readOnly: boolean }) {
  if (readOnly) return <span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Read only</span>;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-400" role="status" aria-live="polite">
      {status === "saving" ? <Loader2 className="size-3.5 animate-spin text-primary" /> : status === "saved" ? <Check className="size-3.5 text-emerald-400" /> : <span className="size-2 rounded-full bg-amber-400" />}
      {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : "Unsaved"}
    </span>
  );
}
