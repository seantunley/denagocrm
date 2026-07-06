"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  registerLibraryDocuments,
  registerLibraryVersion,
  type UploadedFileMeta,
} from "@/app/actions/library";

const CATEGORIES = ["Brochure", "Price list", "Spec sheet", "Warranty", "Other"];

async function uploadDirect(file: File): Promise<UploadedFileMeta> {
  const blob = await upload(`library/${file.name}`, file, {
    access: "public",
    handleUploadUrl: "/api/library/upload",
  });
  return {
    url: blob.url,
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  };
}

export function AddDocumentsForm() {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [category, setCategory] = useState("Brochure");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    if (files.length === 0) {
      setError("Choose at least one file first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const uploaded: UploadedFileMeta[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgress(`Uploading ${i + 1} of ${files.length}: ${files[i].name}…`);
        uploaded.push(await uploadDirect(files[i]));
      }
      setProgress("Saving to library…");
      await registerLibraryDocuments(category, name.trim() || null, uploaded);
      setProgress(`Done — ${uploaded.length} document${uploaded.length !== 1 ? "s" : ""} added.`);
      setFiles([]);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed — please try again.");
      setProgress("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4">
      <div>
        <label className="label">Files * (select multiple at once)</label>
        <input
          type="file"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="text-sm w-full file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-slate-700 file:bg-slate-800 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-slate-300"
        />
        {files.length > 0 && (
          <p className="text-xs text-slate-400 mt-1">
            {files.length} file{files.length !== 1 ? "s" : ""} selected (
            {(files.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB). Each becomes
            its own library document.
          </p>
        )}
      </div>
      <div>
        <label className="label">Category (applies to all)</label>
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Custom name (optional — single file only)</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Denago EV Price List"
        />
      </div>
      {progress && <p className="text-sm text-emerald-400">{progress}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button className="btn-primary" onClick={submit} disabled={busy}>
        {busy ? "Uploading…" : "Add to library"}
      </button>
    </div>
  );
}

export function NewVersionForm({
  documentId,
  nextVersion,
}: {
  documentId: string;
  nextVersion: number;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setStatus(`Uploading ${file.name}…`);
      const meta = await uploadDirect(file);
      await registerLibraryVersion(documentId, note.trim() || null, meta);
      setStatus(`Done — saved as v${nextVersion}.`);
      setFile(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed — please try again.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-4">
      <div>
        <label className="label">File * (will become v{nextVersion})</label>
        <input
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm w-full file:mr-3 file:cursor-pointer file:rounded-lg file:border file:border-slate-700 file:bg-slate-800 file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-slate-300"
        />
      </div>
      <div>
        <label className="label">What changed?</label>
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Updated 2026 pricing"
        />
      </div>
      {status && <p className="text-sm text-emerald-400">{status}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button className="btn-primary" onClick={submit} disabled={busy}>
        {busy ? "Uploading…" : "Upload new version"}
      </button>
    </div>
  );
}
