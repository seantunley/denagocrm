"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEditor } from "@/lib/doceditor/store";
import type { DocumentModel } from "@/lib/doceditor/model";
import { saveDocEditor, importDocEditorTemplate } from "@/app/actions/doceditor";
import { DndController } from "./DndController";
import { Palette } from "./Palette";
import { Canvas } from "./Canvas";
import { PropertiesPanel } from "./PropertiesPanel";
import { VersionHistory } from "./VersionHistory";
import { toast } from "sonner";
import {
  Eye,
  FileDown,
  PanelLeft,
  PanelRight,
  Plus,
  Redo2,
  Save,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  BuilderSaveStatus,
  BuilderWorkspaceBar,
  BuilderWorkspaceShell,
} from "@/components/builder-workspace";

type RecordOption = { value: string; label: string };

export function DocEditor({
  id,
  initialDoc,
  records,
}: {
  id: string;
  initialDoc: DocumentModel;
  records: RecordOption[];
}) {
  const load = useEditor((state) => state.load);
  const doc = useEditor((state) => state.doc);
  const dirty = useEditor((state) => state.dirty);
  const markSaved = useEditor((state) => state.markSaved);
  const undo = useEditor((state) => state.undo);
  const redo = useEditor((state) => state.redo);
  const remove = useEditor((state) => state.remove);
  const removeField = useEditor((state) => state.removeField);
  const addPage = useEditor((state) => state.addPage);

  const [zoom, setZoom] = useState(0.9);
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved"
  >("idle");
  const [record, setRecord] = useState("");
  // Two states, because the panels are two different things at two sizes: a
  // bottom drawer on mobile (closed by default) and a docked column on desktop
  // (open by default). One boolean drove only the drawer, while the column was
  // pinned visible by `md:block` — so on a desktop the toolbar toggles below
  // flipped a value nothing was reading.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [paletteDocked, setPaletteDocked] = useState(true);
  const [inspectorDocked, setInspectorDocked] = useState(true);
  const isDesktop = () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;
  const togglePalette = () => (isDesktop() ? setPaletteDocked((v) => !v) : setPaletteOpen((v) => !v));
  const toggleInspector = () => (isDesktop() ? setInspectorDocked((v) => !v) : setInspectorOpen((v) => !v));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const importRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function onImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset immediately so picking the SAME file twice still fires a change.
    event.target.value = "";
    if (!file) return;
    let payload: unknown;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      toast.error("That file isn't valid JSON.");
      return;
    }
    const result = await importDocEditorTemplate(payload);
    if (!result.ok || !result.id) {
      toast.error(result.error ?? "Could not import that document.");
      return;
    }
    if (result.externalImages) {
      toast.warning(
        `Imported “${result.name}”. ${result.externalImages} linked image(s) point at the original tenant's storage and will need re-uploading.`,
      );
    } else {
      toast.success(`Imported “${result.name}”.`);
    }
    router.push(`/doc-editor/${result.id}`);
  }

  useEffect(() => {
    load(initialDoc);
  }, [load, initialDoc]);

  useEffect(() => {
    if (!doc || !dirty) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const snapshot = doc;
    saveTimer.current = setTimeout(() => {
      saveChain.current = saveChain.current.then(async () => {
        try {
          setSaveState("saving");
          const result = await saveDocEditor(id, snapshot);
          if (result.ok && useEditor.getState().doc === snapshot) {
            markSaved();
            setSaveState("saved");
          } else if (!result.ok) {
            setSaveState("idle");
          }
        } catch {
          setSaveState("idle");
        }
      });
    }, 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [doc, dirty, id, markSaved]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editable =
        target.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "y"
      ) {
        event.preventDefault();
        redo();
        return;
      }
      if (
        !editable &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        const { sel } = useEditor.getState();
        if (sel.blockId) {
          event.preventDefault();
          remove(sel.blockId);
        } else if (sel.fieldId) {
          event.preventDefault();
          removeField(sel.fieldId);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [redo, remove, removeField, undo]);

  const manualSave = async () => {
    if (!doc) return;
    setSaveState("saving");
    const result = await saveDocEditor(id, doc);
    if (result.ok) {
      markSaved();
      setSaveState("saved");
    }
  };

  if (!doc) {
    return (
      <div className="grid h-screen place-items-center text-slate-400">
        Loading editor…
      </div>
    );
  }

  const recordQuery = record
    ? `?record=${encodeURIComponent(record)}`
    : "";
  const previewUrl = `/api/pdf/doc-editor/${id}${recordQuery}`;
  const buttonClass =
    "inline-flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.035] px-2.5 text-xs text-slate-300 transition hover:bg-white/[0.08] hover:text-white";

  return (
    <BuilderWorkspaceShell className="h-screen min-h-0 rounded-none border-0">
      <BuilderWorkspaceBar
        identity={
          <Link
            href="/settings/documents/builder"
            className="text-xs text-slate-400 hover:text-white"
          >
            ← Documents
          </Link>
        }
        title={
          <input
            className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-white hover:border-white/10 focus:border-primary/40 focus:outline-none"
            value={doc.title}
            onChange={(event) =>
              useEditor.getState().setTitle(event.target.value)
            }
          />
        }
        description="Document Editor · drag content onto a print-ready canvas"
        status={
          <BuilderSaveStatus
            status={
              saveState === "saving"
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : "Saved"
            }
          />
        }
      >
        <button
          type="button"
          className={buttonClass}
          onClick={togglePalette}
          title="Show or hide the content palette"
          aria-pressed={paletteDocked}
        >
          <PanelLeft className="size-4" />
          <span className="hidden sm:inline">Content</span>
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={toggleInspector}
          title="Show or hide the properties inspector"
          aria-pressed={inspectorDocked}
        >
          <PanelRight className="size-4" />
          <span className="hidden sm:inline">Inspector</span>
        </button>
        <button type="button" className={buttonClass} onClick={undo} title="Undo (Ctrl+Z)">
          <Undo2 className="size-4" />
        </button>
        <button type="button" className={buttonClass} onClick={redo} title="Redo (Ctrl+Shift+Z)">
          <Redo2 className="size-4" />
        </button>
        <button type="button" className={buttonClass} onClick={() => addPage()} title="Add a page">
          <Plus className="size-4" />
          <span className="hidden sm:inline">Page</span>
        </button>
        <VersionHistory
          id={id}
          save={async () => {
            const current = useEditor.getState().doc;
            if (current) {
              await saveDocEditor(id, current);
              markSaved();
            }
          }}
        />

        <select
          className="h-8 rounded-md border border-slate-300 px-2 text-sm text-slate-700"
          value={record}
          onChange={(event) => setRecord(event.target.value)}
          title="Preview with a compatible record"
        >
          <option value="">Sample data</option>
          {records.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <a
          className={buttonClass}
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
        >
          <Eye className="size-4" />
          Preview
        </a>
        {/* "Prepare for signing" stood here. It sent this template to whatever
            record was chosen in the PREVIEW dropdown beside it — a third way to
            create a signing envelope for a quote, from a design tool, next to a
            control that says preview. Sending is the quote's Send tab. */}
        <button
          type="button"
          className={buttonClass}
          onClick={() => importRef.current?.click()}
          title="Open a portable JSON export as a new document"
        >
          <Upload className="size-4" />
          <span className="hidden sm:inline">Import</span>
        </button>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={onImportFile}
        />
        <details className="relative">
          <summary className={`${buttonClass} cursor-pointer list-none`}>
            <FileDown className="size-4" />
            Export
          </summary>
          <div className="absolute right-0 z-30 mt-1 w-44 rounded-md border border-slate-200 bg-white p-1 text-sm shadow-lg">
            {/* The only export that can come back in — the others flatten the
                document to how it looks and lose the model. */}
            <a
              className="block rounded px-2 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
              href={`/api/doc-editor/${id}/export?format=json`}
            >
              Portable JSON
              <span className="block text-[10px] font-normal text-slate-400">Re-importable, any tenant</span>
            </a>
            <div className="my-1 border-t border-slate-100" />
            {[
              ["html", "Static HTML"],
              ["email", "Email-safe HTML"],
              ["doc", "Word (.doc)"],
            ].map(([format, label]) => (
              <a
                key={format}
                className="block rounded px-2 py-1.5 text-slate-700 hover:bg-slate-50"
                href={`/api/doc-editor/${id}/export?format=${format}${record ? `&record=${encodeURIComponent(record)}` : ""}`}
              >
                {label}
              </a>
            ))}
          </div>
        </details>
        <button type="button" className="btn-primary btn-sm" onClick={manualSave}>
          <Save className="size-4" />
          {saveState === "saving" ? "Saving…" : "Save"}
        </button>
      </BuilderWorkspaceBar>

      <DndController>
        <div className="flex min-h-0 flex-1">
          <aside
            className={`${paletteOpen ? "fixed inset-x-0 bottom-0 z-[80] max-h-[72dvh] rounded-t-3xl shadow-2xl" : "hidden"} w-60 flex-shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50 md:static md:max-h-none md:rounded-none md:shadow-none ${paletteDocked ? "md:block" : "md:hidden"}`}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white p-3 md:hidden">
              <span className="text-sm font-semibold">Content palette</span>
              <button type="button" onClick={() => setPaletteOpen(false)}>
                <X className="size-4" />
              </button>
            </div>
            <Palette />
          </aside>
          <main className="min-w-0 flex-1 overflow-auto">
            <Canvas zoom={zoom} />
          </main>
          <aside
            className={`${inspectorOpen ? "fixed inset-x-0 bottom-0 z-[81] max-h-[78dvh] rounded-t-3xl shadow-2xl" : "hidden"} w-80 flex-shrink-0 overflow-y-auto border-l border-slate-200 bg-white md:static md:max-h-none md:rounded-none md:shadow-none ${inspectorDocked ? "md:block" : "md:hidden"}`}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white p-3 md:hidden">
              <span className="text-sm font-semibold">Inspector</span>
              <button type="button" onClick={() => setInspectorOpen(false)}>
                <X className="size-4" />
              </button>
            </div>
            <PropertiesPanel />
          </aside>
        </div>
      </DndController>

      <div className="flex h-8 flex-shrink-0 items-center gap-4 border-t border-slate-200 bg-white px-3 text-xs text-slate-500">
        <span>
          {doc.pages.length} page{doc.pages.length > 1 ? "s" : ""}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            className="rounded px-1 hover:bg-slate-100"
            onClick={() =>
              setZoom((value) =>
                Math.max(0.4, Math.round((value - 0.1) * 10) / 10),
              )
            }
          >
            −
          </button>
          {Math.round(zoom * 100)}%
          <button
            type="button"
            className="rounded px-1 hover:bg-slate-100"
            onClick={() =>
              setZoom((value) =>
                Math.min(1.6, Math.round((value + 0.1) * 10) / 10),
              )
            }
          >
            +
          </button>
        </span>
        <span className="ml-auto">
          {saveState === "saving"
            ? "Saving…"
            : dirty
              ? "Unsaved changes"
              : saveState === "saved"
                ? "All changes saved"
                : "Saved"}
        </span>
      </div>

    </BuilderWorkspaceShell>
  );
}
