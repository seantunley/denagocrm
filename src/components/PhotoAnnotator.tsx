"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveCheckinAnnotation } from "@/app/actions/jobcards";
import ModalPortal from "@/components/ui/modal-portal";

/* ── Shape model ─────────────────────────────────────────────────────────────
   Coordinates are stored in the image's NATURAL pixel space so the markup can be
   re-rendered at any display scale and re-opened for editing. Stroke/text sizes
   are stored already-scaled (in natural px) so a reopened drawing looks identical. */
export type Pt = { x: number; y: number };
export type AnnShape =
  | { type: "pen"; color: string; width: number; points: Pt[] }
  | { type: "rect"; color: string; width: number; x: number; y: number; w: number; h: number }
  | { type: "ellipse"; color: string; width: number; x: number; y: number; w: number; h: number }
  | { type: "arrow"; color: string; width: number; x1: number; y1: number; x2: number; y2: number }
  | { type: "text"; color: string; size: number; x: number; y: number; text: string };
export type AnnData = { w: number; h: number; shapes: AnnShape[] };

type Tool = "pen" | "rect" | "ellipse" | "arrow" | "text";

const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#ffffff", "#111827"];
const SIZES: Record<string, number> = { s: 4, m: 7, l: 12 };

function drawArrowHead(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width: number) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(width * 4, 12);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(ang - Math.PI / 6), y2 - len * Math.sin(ang - Math.PI / 6));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(ang + Math.PI / 6), y2 - len * Math.sin(ang + Math.PI / 6));
  ctx.stroke();
}

function drawShape(ctx: CanvasRenderingContext2D, s: AnnShape) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  if (s.type === "text") {
    ctx.font = `600 ${s.size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    // Dark halo so light text stays legible on light photos and vice-versa.
    ctx.lineWidth = Math.max(2, s.size / 7);
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.strokeText(s.text, s.x, s.y);
    ctx.fillStyle = s.color;
    ctx.fillText(s.text, s.x, s.y);
    return;
  }
  ctx.lineWidth = s.width;
  ctx.beginPath();
  if (s.type === "pen") {
    s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  } else if (s.type === "rect") {
    ctx.strokeRect(s.x, s.y, s.w, s.h);
  } else if (s.type === "ellipse") {
    ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.type === "arrow") {
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    drawArrowHead(ctx, s.x1, s.y1, s.x2, s.y2, s.width);
  }
}

function AnnotatorModal({
  documentId,
  fileName,
  initial,
  onClose,
  onSaved,
}: {
  documentId: string;
  fileName: string;
  initial: AnnData | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const draftRef = useRef<AnnShape | null>(null);
  const drawingRef = useRef(false);
  const drawStartRef = useRef<Pt>({ x: 0, y: 0 });

  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [shapes, setShapes] = useState<AnnShape[]>(Array.isArray(initial?.shapes) ? initial!.shapes : []);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [sizeKey, setSizeKey] = useState("m");
  const [textValue, setTextValue] = useState("");
  const [saving, setSaving] = useState(false);

  // Load the base image same-origin (untainted canvas → we can export the flatten).
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => setLoadError(true);
    img.src = `/api/jobcard-photo/${documentId}`;
  }, [documentId]);

  const scale = dims ? Math.min(6, Math.max(1, Math.max(dims.w, dims.h) / 1000)) : 1;
  const strokePx = SIZES[sizeKey] * scale;
  const textPx = 26 * scale * (sizeKey === "s" ? 0.7 : sizeKey === "l" ? 1.5 : 1);

  const redraw = useCallback(() => {
    const cvs = canvasRef.current;
    const img = imgRef.current;
    if (!cvs || !img || !dims) return;
    if (cvs.width !== dims.w) cvs.width = dims.w;
    if (cvs.height !== dims.h) cvs.height = dims.h;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, dims.w, dims.h);
    ctx.drawImage(img, 0, 0, dims.w, dims.h);
    for (const s of shapes) drawShape(ctx, s);
    if (draftRef.current) drawShape(ctx, draftRef.current);
  }, [dims, shapes]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toNat = (e: React.PointerEvent): Pt => {
    const cvs = canvasRef.current!;
    const r = cvs.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * cvs.width,
      y: ((e.clientY - r.top) / r.height) * cvs.height,
    };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!dims) return;
    const p = toNat(e);
    if (tool === "text") {
      const text = textValue.trim();
      if (text) setShapes((s) => [...s, { type: "text", color, size: textPx, x: p.x, y: p.y, text }]);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    if (tool === "pen") draftRef.current = { type: "pen", color, width: strokePx, points: [p] };
    else if (tool === "arrow") draftRef.current = { type: "arrow", color, width: strokePx, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    else draftRef.current = { type: tool, color, width: strokePx, x: p.x, y: p.y, w: 0, h: 0 };
    redraw();
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawingRef.current || !draftRef.current) return;
    const p = toNat(e);
    const d = draftRef.current;
    if (d.type === "pen") d.points.push(p);
    else if (d.type === "arrow") {
      d.x2 = p.x;
      d.y2 = p.y;
    } else if (d.type === "rect" || d.type === "ellipse") {
      const start = drawStartRef.current;
      d.x = Math.min(start.x, p.x);
      d.y = Math.min(start.y, p.y);
      d.w = Math.abs(p.x - start.x);
      d.h = Math.abs(p.y - start.y);
    }
    redraw();
  };

  const onDownWrapped = (e: React.PointerEvent) => {
    drawStartRef.current = toNat(e);
    onDown(e);
  };

  const onUp = () => {
    const d = draftRef.current;
    drawingRef.current = false;
    draftRef.current = null;
    if (!d) return;
    const meaningful =
      (d.type === "pen" && d.points.length > 1) ||
      (d.type === "arrow" && Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 4) ||
      ((d.type === "rect" || d.type === "ellipse") && (d.w > 4 || d.h > 4));
    if (meaningful) setShapes((s) => [...s, d]);
    else redraw();
  };

  const save = async () => {
    const cvs = canvasRef.current;
    if (!cvs || !dims) return;
    setSaving(true);
    try {
      // Export JPEG (not PNG): the canvas is opaque (the photo fills it), and a
      // natural-size PNG of a high-res phone photo can blow past the 10 MB save
      // limit. JPEG at 0.9 keeps markup legible while staying well under it.
      const blob = await new Promise<Blob | null>((res) => cvs.toBlob(res, "image/jpeg", 0.9));
      if (!blob) throw new Error("Could not render the marked-up image");
      const fd = new FormData();
      fd.set("documentId", documentId);
      fd.set("annotations", JSON.stringify({ w: dims.w, h: dims.h, shapes } satisfies AnnData));
      fd.set("image", blob, "annotated.jpg");
      await saveCheckinAnnotation(fd);
      onSaved();
    } catch {
      setSaving(false);
    }
  };

  const toolBtn = (t: Tool, label: string, glyph: string) => (
    <button
      type="button"
      onClick={() => setTool(t)}
      title={label}
      aria-pressed={tool === t}
      className={`grid size-9 place-items-center rounded-md text-sm transition-colors ${
        tool === t ? "bg-orange-600 text-white" : "bg-white/[0.06] text-slate-200 hover:bg-white/[0.12]"
      }`}
    >
      {glyph}
    </button>
  );

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/85 backdrop-blur-sm">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#0b0d10] px-3 py-2">
        <div className="flex items-center gap-1">
          {toolBtn("pen", "Freehand pen", "✏️")}
          {toolBtn("rect", "Rectangle", "▭")}
          {toolBtn("ellipse", "Circle", "◯")}
          {toolBtn("arrow", "Arrow", "↗")}
          {toolBtn("text", "Text label", "T")}
        </div>
        {tool === "text" && (
          <input
            type="text"
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            placeholder="Type a label, then click the photo"
            className="w-56 rounded-md border border-white/15 bg-white/[0.06] px-2 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-orange-500/60 focus:outline-none"
          />
        )}
        <div className="mx-1 h-6 w-px bg-white/10" />
        <div className="flex items-center gap-1">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              title={c}
              aria-label={`Colour ${c}`}
              className={`size-6 rounded-full border transition-transform ${
                color === c ? "scale-110 border-white ring-2 ring-white/40" : "border-white/25"
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <div className="mx-1 h-6 w-px bg-white/10" />
        <div className="flex items-center gap-1">
          {(["s", "m", "l"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setSizeKey(k)}
              aria-pressed={sizeKey === k}
              title={`${k === "s" ? "Thin" : k === "m" ? "Medium" : "Thick"} stroke`}
              className={`grid size-9 place-items-center rounded-md transition-colors ${
                sizeKey === k ? "bg-orange-600 text-white" : "bg-white/[0.06] text-slate-200 hover:bg-white/[0.12]"
              }`}
            >
              <span className="rounded-full bg-current" style={{ width: k === "s" ? 4 : k === "m" ? 7 : 11, height: k === "s" ? 4 : k === "m" ? 7 : 11 }} />
            </button>
          ))}
        </div>
        <div className="mx-1 h-6 w-px bg-white/10" />
        <button type="button" onClick={() => setShapes((s) => s.slice(0, -1))} disabled={!shapes.length} className="btn-secondary btn-sm disabled:opacity-40">
          Undo
        </button>
        <button type="button" onClick={() => setShapes([])} disabled={!shapes.length} className="btn-secondary btn-sm disabled:opacity-40">
          Clear
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onClose} className="btn-secondary btn-sm">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving || !dims} className="btn-primary btn-sm">
            {saving ? "Saving…" : "Save markup"}
          </button>
        </div>
      </div>

      {/* Canvas stage */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        {loadError ? (
          <p className="text-sm text-slate-300">Could not load this photo.</p>
        ) : !dims ? (
          <p className="text-sm text-slate-400">Loading photo…</p>
        ) : (
          <canvas
            ref={canvasRef}
            onPointerDown={onDownWrapped}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            className="max-h-full max-w-full touch-none rounded-lg shadow-2xl"
            style={{ cursor: tool === "text" ? "text" : "crosshair" }}
          />
        )}
      </div>
      <p className="border-t border-white/10 bg-[#0b0d10] px-3 py-1.5 text-center text-[11px] text-slate-500">
        Marking up “{fileName}” — the original photo is kept untouched.
      </p>
    </div>
    </ModalPortal>
  );
}

export function AnnotatablePhoto({
  doc,
}: {
  doc: { id: string; fileName: string; annotated: boolean; annotations: AnnData | null };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rev, setRev] = useState(0);
  const [annotated, setAnnotated] = useState(doc.annotated);

  const src = `/api/jobcard-photo/${doc.id}?${annotated ? "v=annotated&" : ""}r=${rev}`;

  return (
    <>
      <div className="group relative h-24 w-24 shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={doc.fileName}
          className="h-24 w-24 rounded-lg border border-slate-700 object-cover transition-colors group-hover:border-orange-500"
        />
        {annotated && (
          <span className="absolute left-1 top-1 rounded bg-orange-600/90 px-1 py-0.5 text-[9px] font-semibold text-white">
            Marked
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="absolute inset-x-0 bottom-0 rounded-b-lg bg-black/70 py-1 text-[10px] font-semibold text-white opacity-90 transition-opacity hover:bg-black/85 group-hover:opacity-100"
        >
          ✏️ Mark up
        </button>
      </div>
      {open && (
        <AnnotatorModal
          documentId={doc.id}
          fileName={doc.fileName}
          initial={doc.annotations}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setAnnotated(true);
            setRev((r) => r + 1);
            setOpen(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
