"use client";

import { useState } from "react";
import Moveable from "react-moveable";
import { useEditor } from "@/lib/doceditor/store";
import type { DocumentPage, OverlayField } from "@/lib/doceditor/model";

const KIND_LABEL: Record<OverlayField["kind"], string> = {
  signature: "Signature", initials: "Initials", date: "Date", text: "Text field", checkbox: "Checkbox",
  radio: "Radio", dropdown: "Dropdown", attachment: "Attachment", stamp: "Stamp",
};

/** The recipient/form-field layer: page-anchored fields, dragged & resized with react-moveable. */
export function OverlayLayer({ page, zoom }: { page: DocumentPage; zoom: number }) {
  const sel = useEditor((s) => s.sel);
  const selectField = useEditor((s) => s.selectField);
  const updateField = useEditor((s) => s.updateField);
  const recipients = useEditor((s) => s.doc?.recipients ?? []);
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);

  const fields = page.overlayFields.filter((f) => f.anchor.mode === "page");
  const selectedField = fields.find((f) => f.id === sel.fieldId) ?? null;

  return (
    <div className="pointer-events-none absolute inset-0">
      {fields.map((f) => {
        const recipient = recipients.find((r) => r.id === f.recipientId);
        const color = recipient?.color ?? "#64748b";
        const isSel = sel.fieldId === f.id;
        return (
          <div
            key={f.id}
            ref={isSel ? setTargetEl : undefined}
            data-field-id={f.id}
            onMouseDown={(e) => { e.stopPropagation(); selectField(f.id); }}
            className={`pointer-events-auto absolute flex cursor-move flex-col items-center justify-center rounded text-center ${isSel ? "z-10" : ""}`}
            style={{
              left: f.anchor.x * zoom, top: f.anchor.y * zoom, width: f.width * zoom, height: f.height * zoom,
              border: `1.5px dashed ${color}`, background: `${color}14`, color, fontSize: 11, fontWeight: 600,
            }}
          >
            <span>{f.label || KIND_LABEL[f.kind]}</span>
            <span style={{ fontSize: 9, opacity: 0.8 }}>{recipient ? recipient.name || recipient.email || "Recipient" : "Unassigned"}</span>
          </div>
        );
      })}

      {selectedField && targetEl && (
        <Moveable
          target={targetEl}
          draggable resizable origin={false} throttleDrag={0}
          onDrag={({ target, left, top }) => { const el = target as HTMLElement; el.style.left = `${left}px`; el.style.top = `${top}px`; }}
          onDragEnd={({ target }) => {
            const el = target as HTMLElement;
            updateField(selectedField.id, { anchor: { ...selectedField.anchor, x: Math.max(0, parseFloat(el.style.left) / zoom), y: Math.max(0, parseFloat(el.style.top) / zoom) } });
          }}
          onResize={({ target, width, height, drag }) => {
            const el = target as HTMLElement;
            el.style.width = `${width}px`; el.style.height = `${height}px`;
            el.style.left = `${drag.left}px`; el.style.top = `${drag.top}px`;
          }}
          onResizeEnd={({ target }) => {
            const el = target as HTMLElement;
            updateField(selectedField.id, {
              width: Math.max(24, parseFloat(el.style.width) / zoom),
              height: Math.max(20, parseFloat(el.style.height) / zoom),
              anchor: { ...selectedField.anchor, x: Math.max(0, parseFloat(el.style.left) / zoom), y: Math.max(0, parseFloat(el.style.top) / zoom) },
            });
          }}
        />
      )}
    </div>
  );
}
