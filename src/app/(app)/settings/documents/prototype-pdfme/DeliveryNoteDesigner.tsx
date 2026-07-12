"use client";

import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deliveryNoteTemplate, deliveryNoteSample } from "./docTemplate";

// Structural type only — importing a type from "@pdfme/ui" pulls its heavy,
// browser-only graph (clawpdf/pdfium) into this module's static graph, so we
// keep every @pdfme reference inside the effect/handler instead.
type PdfDesigner = {
  getTemplate: () => import("@pdfme/common").Template;
  destroy: () => void;
};

/**
 * PROTOTYPE editor: mounts the pdfme drag-drop Designer for a Delivery Note.
 * pdfme is browser-only, so every pdfme module is imported dynamically inside
 * the effect / handler (never at module top level) to keep it out of SSR.
 */
export function DeliveryNoteDesigner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const designerRef = useRef<PdfDesigner | null>(null);
  const [ready, setReady] = useState(false);
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
        designerRef.current = new Designer({
          domContainer: containerRef.current,
          template: deliveryNoteTemplate,
          plugins: {
            Text: schemas.text,
            Table: schemas.table,
            Signature: schemas.signature,
            Line: schemas.line,
            Rectangle: schemas.rectangle,
            Image: schemas.image,
          },
        });
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
  }, []);

  async function generatePdf() {
    if (!designerRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const [{ generate }, schemas] = await Promise.all([
        import("@pdfme/generator"),
        import("@pdfme/schemas"),
      ]);
      // Use whatever the user has just designed on screen, merged with mock data.
      const template = designerRef.current.getTemplate();
      const pdf = await generate({
        template,
        inputs: [deliveryNoteSample],
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
      setError(e instanceof Error ? e.message : "Could not generate the PDF.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Drag fields, edit text inline, resize — then generate the real PDF with mock data.
        </p>
        <Button type="button" onClick={generatePdf} disabled={!ready || busy}>
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
          {busy ? "Generating…" : "Generate PDF (mock data)"}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300" role="alert">
          {error}
        </div>
      )}

      {/* pdfme mounts its own UI (antd) into this container */}
      <div
        ref={containerRef}
        className="min-h-[75vh] overflow-hidden rounded-xl border border-border bg-white"
      />
      {!ready && !error && (
        <p className="text-xs text-muted-foreground">Loading the editor…</p>
      )}
    </div>
  );
}
