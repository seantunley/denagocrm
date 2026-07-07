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
      e.preventDefault();
    };
    const onReset = () => setPreview(null);

    form.addEventListener("paste", onPaste as EventListener);
    form.addEventListener("reset", onReset);
    return () => {
      form.removeEventListener("paste", onPaste as EventListener);
      form.removeEventListener("reset", onReset);
    };
  }, []);

  return (
    <div ref={wrapRef} className="space-y-1.5">
      <input
        ref={fileRef}
        type="file"
        name={name}
        accept="image/*"
        onChange={(e) => {
          const f = e.target.files?.[0];
          setPreview(f ? URL.createObjectURL(f) : null);
        }}
        className="block w-full text-xs text-slate-500 file:btn-secondary file:btn-sm file:mr-2 file:border-0"
      />
      <p className="text-[10px] text-slate-600">📋 …or just paste a screenshot (Ctrl+V)</p>
      {preview && (
        <div className="flex items-start gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Pasted" className="max-h-24 rounded-lg border border-slate-700" />
          <button
            type="button"
            onClick={() => {
              if (fileRef.current) fileRef.current.value = "";
              setPreview(null);
            }}
            className="text-xs text-slate-500 hover:text-red-400 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
