"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Image field that also accepts a pasted screenshot (Ctrl+V anywhere in the
 * surrounding form). Shows a preview; the file rides the normal form submit.
 */
export default function PasteImageInput({ name = "image" }: { name?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const form = wrapRef.current?.closest("form");
    if (!form) return;

    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith("image/")
      );
      if (!item || !fileRef.current) return;
      const file = item.getAsFile();
      if (!file) return;
      const dt = new DataTransfer();
      dt.items.add(new File([file], file.name || "screenshot.png", { type: file.type }));
      fileRef.current.files = dt.files;
      setPreview(URL.createObjectURL(file));
      setLabel("Pasted screenshot");
      e.preventDefault();
    };
    const onReset = () => {
      setPreview(null);
      setLabel(null);
    };

    form.addEventListener("paste", onPaste as EventListener);
    form.addEventListener("reset", onReset);
    return () => {
      form.removeEventListener("paste", onPaste as EventListener);
      form.removeEventListener("reset", onReset);
    };
  }, []);

  return (
    <div ref={wrapRef}>
      <input
        ref={fileRef}
        type="file"
        name={name}
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          setPreview(f ? URL.createObjectURL(f) : null);
          setLabel(f?.name ?? null);
        }}
      />
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="btn-secondary btn-sm"
        >
          📷 Add image
        </button>
        <span className="text-xs text-slate-500">or paste a screenshot here (Ctrl+V)</span>
      </div>
      {preview && (
        <div className="flex items-start gap-2 mt-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Attached" className="max-h-24 rounded-lg border border-slate-700" />
          <div className="text-xs text-slate-400">
            {label}
            <button
              type="button"
              onClick={() => {
                if (fileRef.current) fileRef.current.value = "";
                setPreview(null);
                setLabel(null);
              }}
              className="block text-slate-500 hover:text-red-400 cursor-pointer mt-1"
            >
              ✕ Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
