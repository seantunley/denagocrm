"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createTemplate, updateTemplate, deleteTemplate } from "@/app/actions/emails";

type Template = { id: string; name: string; subject: string; body: string };

export default function TemplateManager({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);

  const editT = editing;
  const showForm = creating || editing;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Templates</h2>
        {!showForm && (
          <button className="btn-primary btn-sm" onClick={() => { setCreating(true); setEditing(null); }}>
            + New template
          </button>
        )}
      </div>

      {showForm && (
        <form
          action={editT ? updateTemplate.bind(null, editT.id) : createTemplate}
          onSubmit={() => setTimeout(() => { setCreating(false); setEditing(null); router.refresh(); }, 400)}
          className="card space-y-3"
        >
          <div>
            <label className="label">Template name</label>
            <input name="name" className="input" required defaultValue={editT?.name ?? ""} placeholder="e.g. Winter promo" />
          </div>
          <div>
            <label className="label">Subject</label>
            <input name="subject" className="input" required defaultValue={editT?.subject ?? ""} />
          </div>
          <div>
            <label className="label">Body</label>
            <textarea name="body" className="input font-mono text-xs" rows={12} required defaultValue={editT?.body ?? ""} placeholder="Plain text or HTML. Use {{first_name}}, {{name}} to personalise." />
            <p className="text-xs text-slate-500 mt-1">
              Plain text or HTML. Placeholders: <code>{"{{first_name}}"}</code>, <code>{"{{name}}"}</code>.
              Templates are shared with service-reminder emails.
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary btn-sm">{editT ? "Save template" : "Create template"}</button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { setCreating(false); setEditing(null); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="card p-0">
        {templates.length === 0 ? (
          <p className="text-sm text-slate-400 p-4">No templates yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {templates.map((t) => (
              <li key={t.id} className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{t.name}</p>
                  <p className="text-xs text-slate-400 truncate">{t.subject}</p>
                </div>
                <button className="btn-secondary btn-sm" onClick={() => { setEditing(t); setCreating(false); }}>
                  Edit
                </button>
                <form action={deleteTemplate.bind(null, t.id)} onSubmit={() => setTimeout(() => router.refresh(), 400)}>
                  <button className="btn-danger btn-sm">Delete</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
