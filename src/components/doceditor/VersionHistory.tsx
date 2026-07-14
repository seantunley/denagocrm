"use client";

import { useState } from "react";
import { publishBuilderVersion, restoreBuilderVersion, listBuilderVersionsAction } from "@/app/actions/docbuilder";

type Version = { id: string; version: number; label: string | null; publishedBy: string | null; publishedAt: string };

/** Version history drawer: publish an immutable snapshot, list history, restore. */
export function VersionHistory({ id, save }: { id: string; save: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  const refresh = async () => setVersions(await listBuilderVersionsAction(id));
  const toggle = async () => { const next = !open; setOpen(next); if (next) await refresh(); };

  const publish = async () => {
    setBusy("publish");
    await save();                       // flush the current draft first
    await publishBuilderVersion(id, label.trim() || undefined);
    setLabel("");
    await refresh();
    setBusy(null);
  };
  const restore = async (versionId: string) => {
    if (!confirm("Restore this version? Your current draft will be replaced (you can re-restore any version).")) return;
    setBusy(versionId);
    await restoreBuilderVersion(id, versionId);
    window.location.reload();
  };

  const btn = "inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 px-2.5 text-sm text-slate-700 hover:bg-slate-50";

  return (
    <>
      <button type="button" className={btn} onClick={toggle} title="Version history">🕑 History</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setOpen(false)} />
          <div className="fixed right-0 top-0 z-50 flex h-full w-80 flex-col border-l border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 p-3">
              <span className="text-sm font-semibold text-slate-800">Version history</span>
              <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="border-b border-slate-100 p-3">
              <input className="mb-2 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" placeholder="Label (optional) e.g. Sent to client" value={label} onChange={(e) => setLabel(e.target.value)} />
              <button type="button" disabled={busy === "publish"} onClick={publish} className="w-full rounded-md bg-orange-600 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-60">
                {busy === "publish" ? "Saving…" : "Publish current as a version"}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {versions.length === 0 ? (
                <p className="p-3 text-xs text-slate-400">No versions yet. Publish one above to snapshot the current document.</p>
              ) : (
                <ul className="space-y-1.5">
                  {versions.map((v) => (
                    <li key={v.id} className="rounded-md border border-slate-200 p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-800">v{v.version}{v.label ? ` · ${v.label}` : ""}</span>
                        <button type="button" disabled={busy === v.id} onClick={() => restore(v.id)} className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-60">
                          {busy === v.id ? "…" : "Restore"}
                        </button>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">{new Date(v.publishedAt).toLocaleString()}{v.publishedBy ? ` · ${v.publishedBy}` : ""}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
