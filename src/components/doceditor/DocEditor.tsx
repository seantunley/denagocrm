"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useEditor } from "@/lib/doceditor/store";
import type { DocumentModel } from "@/lib/doceditor/model";
import { parseBuilderRecord } from "@/lib/docbuilder/recordBinding";
import { saveDocEditor, sendDocForSigning } from "@/app/actions/doceditor";
import { DndController } from "./DndController";
import { Palette } from "./Palette";
import { Canvas } from "./Canvas";
import { PropertiesPanel } from "./PropertiesPanel";
import { VersionHistory } from "./VersionHistory";
import { SignSendWizard } from "./SignSendWizard";
import { toast } from "sonner";
import {
  Eye,
  FileDown,
  FileSignature,
  PanelLeft,
  PanelRight,
  Plus,
  Redo2,
  Save,
  Undo2,
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [signWizardOpen, setSignWizardOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());

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

  const confirmSend = async (dispatch: boolean) => {
    const current = useEditor.getState().doc;
    if (!current) return;
    setSigning(true);
    try {
      await saveDocEditor(id, current);
      markSaved();
      const parsed = parseBuilderRecord(record);
      const result = await sendDocForSigning(
        id,
        parsed?.kind === "quote" ? parsed.id : null,
        parsed?.kind === "jobcard" ? parsed.id : null,
        { dispatch },
      );
      if (result.ok) {
        toast.success(result.message);
        setSignWizardOpen(false);
      } else {
        toast.error(`Couldn’t prepare for signing: ${result.message}`);
      }
    } catch {
      // A thrown/timed-out server action must not leave an unhandled rejection.
      // The action reuses an existing open request for this document on retry, so
      // trying again won't mint a duplicate — surface a retry prompt instead.
      toast.error("Preparing for signing failed — please try again. If you’d already started, check the Signatures hub before retrying.");
    } finally {
      setSigning(false);
    }
  };

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
          onClick={() => setPaletteOpen((value) => !value)}
          title="Content palette"
        >
          <PanelLeft className="size-4" />
          <span className="hidden sm:inline">Content</span>
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => setInspectorOpen((value) => !value)}
          title="Properties inspector"
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
        <button
          type="button"
          className={buttonClass}
          onClick={() => setSignWizardOpen(true)}
          title="Review recipients, then send now or save a draft"
        >
          <FileSignature className="size-4" />
          Prepare for signing
        </button>
        <details className="relative">
          <summary className={`${buttonClass} cursor-pointer list-none`}>
            <FileDown className="size-4" />
            Export
          </summary>
          <div className="absolute right-0 z-30 mt-1 w-44 rounded-md border border-slate-200 bg-white p-1 text-sm shadow-lg">
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
            className={`${paletteOpen ? "fixed inset-x-0 bottom-0 z-[80] max-h-[72dvh] rounded-t-3xl shadow-2xl" : "hidden"} w-60 flex-shrink-0 overflow-y-auto border-r border-slate-200 bg-slate-50 md:static md:block md:max-h-none md:rounded-none md:shadow-none`}
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
            className={`${inspectorOpen ? "fixed inset-x-0 bottom-0 z-[81] max-h-[78dvh] rounded-t-3xl shadow-2xl" : "hidden"} w-80 flex-shrink-0 overflow-y-auto border-l border-slate-200 bg-white md:static md:block md:max-h-none md:rounded-none md:shadow-none`}
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

      <SignSendWizard
        open={signWizardOpen}
        onClose={() => !signing && setSignWizardOpen(false)}
        recipients={(doc?.recipients ?? []).map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role }))}
        fields={(doc?.pages ?? []).flatMap((p) => p.overlayFields).map((f) => ({ recipientId: f.recipientId, required: f.required }))}
        busy={signing}
        onConfirm={confirmSend}
      />
    </BuilderWorkspaceShell>
  );
}
