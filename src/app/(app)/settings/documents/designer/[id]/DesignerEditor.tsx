"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, LoaderCircle, Save, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { savePdfmeSchema } from "@/app/actions/pdfmeDocs";

// Structural type only — importing a value/type from "@pdfme/ui" statically would
// pull its heavy, browser-only graph (pdfium) into this module's static graph, so
// every @pdfme reference stays inside the effect / handlers.
type PdfDesigner = {
  getTemplate: () => import("@pdfme/common").Template;
  destroy: () => void;
};

export default function DesignerEditor({
  id,
  name,
  initialSchema,
  sample,
}: {
  id: string;
  name: string;
  initialSchema: import("@pdfme/common").Template;
  sample: Record<string, string>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const designerRef = useRef<PdfDesigner | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ Designer }, schemas] = await Promise.all([
          import("@pdfme/ui"),
          import("@pdfme/schemas"),
        ]);
        if (cancelled || !containerRef.current) return;
        designerRef.current?.destroy();
        designerRef.current = new Designer({
          domContainer: containerRef.current,
          template: initialSchema,
          plugins: {
            Text: schemas.text,
            Table: schemas.table,
            Signature: schemas.signature,
            Line: schemas.line,
            Rectangle: schemas.rectangle,
            Image: schemas.image,
          },
        });
        // Any edit invalidates the "saved" tick.
        designerRef.current &&
          (designerRef.current as unknown as { onChangeTemplate?: (cb: () => void) => void })
            .onChangeTemplate?.(() => setSavedAt(null));
        setReady(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load the editor.");
      }
    })();
    return () => {
      cancelled = true;
      designerRef.current?.destroy();
      designerRef.current = null;
    };
    // initialSchema is the server-loaded template; re-mount only if the row changes.
  }, [id, initialSchema]);

  async function save() {
    if (!designerRef.current) return;
    setSaving(true);
    setError(null);
    try {
      const template = designerRef.current.getTemplate();
      const res = await savePdfmeSchema(id, template);
      if (res.ok) setSavedAt(Date.now());
      else setError(res.error ?? "Could not save.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function preview() {
    if (!designerRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const [{ generate }, schemas] = await Promise.all([
        import("@pdfme/generator"),
        import("@pdfme/schemas"),
      ]);
      const template = designerRef.current.getTemplate();
      const pdf = await generate({
        template,
        inputs: [sample],
        plugins: {
          text: schemas.text,
          table: schemas.table,
          signature: schemas.signature,
          line: schemas.line,
          rectangle: schemas.rectangle,
          image: schemas.image,
        },
      });
      const blob = new Blob([pdf as BlobPart], { type: "application/pdf" });
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate the preview.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            href="/settings/documents?tab=designer"
            className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Documents
          </Link>
          <h1 className="truncate text-lg font-semibold tracking-tight">{name}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={preview} disabled={!ready || busy}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
            {busy ? "Generating…" : "Preview PDF"}
          </Button>
          <Button type="button" onClick={save} disabled={!ready || saving}>
            {saving ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : savedAt ? (
              <Check className="size-4" />
            ) : (
              <Save className="size-4" />
            )}
            {saving ? "Saving…" : savedAt ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Drag fields from the right panel, click to edit. <strong>Preview PDF</strong> renders with
        sample data; <strong>Save</strong> stores this layout. The live customer print/signing flow
        is unaffected — this Designer is a separate, opt-in editor.
      </p>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300" role="alert">
          {error}
        </div>
      )}

      <div
        ref={containerRef}
        className="min-h-[75vh] overflow-hidden rounded-xl border border-border bg-white"
      />
      {!ready && !error && <p className="text-xs text-muted-foreground">Loading the editor…</p>}
    </div>
  );
}
