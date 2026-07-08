"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { previewAudience, saveSegment } from "@/app/actions/campaigns";

type Tag = { id: string; name: string };

const PROVINCES = [
  "Western Cape", "Eastern Cape", "Northern Cape", "Gauteng", "KwaZulu-Natal",
  "Free State", "North West", "Limpopo", "Mpumalanga",
];
const SOURCES = ["manual", "facebook", "instagram", "website", "whatsapp"];

type Criteria = {
  source: string; tagId: string; province: string;
  hasVehicle: boolean; serviceDue: boolean; wonOnly: boolean;
};
const EMPTY: Criteria = { source: "", tagId: "", province: "", hasVehicle: false, serviceDue: false, wonOnly: false };

export default function SegmentBuilder({ tags }: { tags: Tag[] }) {
  const router = useRouter();
  const [cr, setCr] = useState<Criteria>(EMPTY);
  const [name, setName] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [saving, setSaving] = useState(false);

  function fd() {
    const f = new FormData();
    f.set("channel", "email");
    f.set("f_source", cr.source);
    f.set("f_tagId", cr.tagId);
    f.set("f_province", cr.province);
    if (cr.hasVehicle) f.set("f_hasVehicle", "on");
    if (cr.serviceDue) f.set("f_serviceDue", "on");
    if (cr.wonOnly) f.set("f_wonOnly", "on");
    return f;
  }

  async function preview() {
    setCounting(true);
    setCount((await previewAudience(fd())).count);
    setCounting(false);
  }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    const f = fd();
    f.set("name", name.trim());
    await saveSegment(f);
    setSaving(false);
    setName("");
    setCr(EMPTY);
    setCount(null);
    router.refresh();
  }

  return (
    <div className="card space-y-4">
      <h2 className="font-semibold">New audience</h2>
      <div className="grid md:grid-cols-3 gap-3">
        <div>
          <label className="label">Source</label>
          <select className="input" value={cr.source} onChange={(e) => setCr({ ...cr, source: e.target.value })}>
            <option value="">Any</option>
            {SOURCES.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Tag</label>
          <select className="input" value={cr.tagId} onChange={(e) => setCr({ ...cr, tagId: e.target.value })}>
            <option value="">Any</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Province</label>
          <select className="input" value={cr.province} onChange={(e) => setCr({ ...cr, province: e.target.value })}>
            <option value="">Any</option>
            {PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={cr.hasVehicle} onChange={(e) => setCr({ ...cr, hasVehicle: e.target.checked })} /> Owns a cart
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={cr.serviceDue} onChange={(e) => setCr({ ...cr, serviceDue: e.target.checked })} /> Service due
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={cr.wonOnly} onChange={(e) => setCr({ ...cr, wonOnly: e.target.checked })} /> Bought before
        </label>
      </div>
      <div className="flex items-center gap-3 flex-wrap border-t border-slate-800 pt-3">
        <button type="button" onClick={preview} className="btn-secondary btn-sm">
          {counting ? "Counting…" : "Preview count"}
        </button>
        {count != null && <span className="text-sm text-emerald-400">{count} recipient{count === 1 ? "" : "s"}</span>}
        <span className="flex-1" />
        <input className="input w-44" placeholder="Audience name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" onClick={save} disabled={saving || !name.trim()} className="btn-primary btn-sm">
          {saving ? "Saving…" : "Save audience"}
        </button>
      </div>
    </div>
  );
}
