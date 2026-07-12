"use client";

import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DOC_TEMPLATES, DOC_KEYS } from "./docTemplate";

// Structural type only — importing a type from "@pdfme/ui" would pull its heavy,
// browser-only graph (clawpdf/pdfium) into this module's static graph, so we
// keep every @pdfme reference inside the effect / handler instead.
type PdfDesigner = {
  getTemplate: () => import("@pdfme/common").Template;
  destroy: () => void;
};

export function PdfmeDocEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const designerRef = useRef<PdfDesigner | null>(null);
  const [active, setActive] = useState<string>(DOC_KEYS[0]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)mount the Designer whenever the selected document changes.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
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
          template: DOC_TEMPLATES[active].template,
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
  }, [active]);

  async function generatePdf() {
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
        inputs: [DOC_TEMPLATES[active].sample],
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
        {/* Document switcher — each is a real current template converted to pdfme */}
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {DOC_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setActive(key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                active === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {DOC_TEMPLATES[key].label}
            </button>
          ))}
        </div>
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
      {!ready && !error && <p className="text-xs text-muted-foreground">Loading the editor…</p>}
    </div>
  );
}
