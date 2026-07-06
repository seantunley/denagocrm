"use client";

import { useState, useEffect, useActionState } from "react";
import Link from "next/link";
import { sendEmailAction, type SendEmailState } from "@/app/actions/emails";
import RichTextEditor from "@/components/RichTextEditor";

/** Converts a plain-text template into simple HTML paragraphs for the editor. */
function textToHtml(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export type RenderedTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
};

export default function EmailComposer({
  defaultTo,
  templates,
  smtpConfigured,
  leadId,
  contactId,
  revalidate,
  libraryDocs = [],
}: {
  defaultTo: string;
  templates: RenderedTemplate[];
  smtpConfigured: boolean;
  leadId?: string;
  contactId?: string;
  revalidate: string;
  libraryDocs?: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [attached, setAttached] = useState<string[]>([]);
  const [attachFilter, setAttachFilter] = useState("");
  const [state, formAction, pending] = useActionState<SendEmailState | undefined, FormData>(
    sendEmailAction,
    undefined
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  function applyTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (t) {
      setSubject(t.subject);
      setBody(textToHtml(t.body));
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="card w-full text-left font-semibold hover:border-orange-600/60 transition-colors cursor-pointer flex items-center justify-between"
      >
        <span>✉️ Send email</span>
        <span className="text-xs text-slate-500 font-normal">opens composer</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-8 overflow-y-auto"
          onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="card w-full max-w-3xl pb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">✉️ Send email</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-white text-2xl leading-none cursor-pointer"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {!smtpConfigured ? (
              <p className="text-sm text-slate-400">
                Email sending isn&apos;t configured yet — add your SMTP details in{" "}
                <Link href="/settings?tab=email" className="text-orange-400 hover:underline">
                  Settings → Email
                </Link>
                .
              </p>
            ) : (
              <form action={formAction} className="space-y-3">
          {leadId && <input type="hidden" name="leadId" value={leadId} />}
          {contactId && <input type="hidden" name="contactId" value={contactId} />}
          <input type="hidden" name="revalidate" value={revalidate} />
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="label">To</label>
              <input name="to" type="email" className="input" required defaultValue={defaultTo} />
            </div>
            <div>
              <label className="label">Template</label>
              <select
                className="input"
                defaultValue=""
                onChange={(e) => applyTemplate(e.target.value)}
              >
                <option value="">— write from scratch —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Subject</label>
            <input
              name="subject"
              className="input"
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Message</label>
            <input type="hidden" name="bodyHtml" value={body} />
            <RichTextEditor value={body} onChange={setBody} />
            <p className="text-xs text-slate-500 mt-1">
              Your branded signature is added automatically —{" "}
              <Link href="/settings?tab=team" className="text-orange-400 hover:underline">
                edit it in Settings
              </Link>
              .
            </p>
          </div>
          <div>
            <label className="label">Attachments</label>
            <div className="flex flex-wrap items-center gap-1.5">
              {attached.map((id) => {
                const d = libraryDocs.find((x) => x.id === id);
                return (
                  <span
                    key={id}
                    className="badge bg-slate-800 text-slate-200 gap-1.5 py-1"
                  >
                    📄 {d?.label ?? "Document"}
                    <button
                      type="button"
                      onClick={() => setAttached((a) => a.filter((x) => x !== id))}
                      className="text-slate-500 hover:text-red-400 cursor-pointer"
                      aria-label="Remove attachment"
                    >
                      ✕
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setAttachOpen(true)}
                className="btn-secondary btn-sm"
                disabled={libraryDocs.length === 0}
              >
                📎 Attach from library
              </button>
              {libraryDocs.length === 0 && (
                <span className="text-xs text-slate-500">Library is empty.</span>
              )}
            </div>
            {attached.map((id) => (
              <input key={id} type="hidden" name="attach" value={id} />
            ))}
          </div>

          {attachOpen && (
            <div
              className="fixed inset-0 z-[60] flex items-start justify-center bg-black/70 p-4 pt-16"
              onPointerDown={(e) => e.target === e.currentTarget && setAttachOpen(false)}
            >
              <div className="card w-full max-w-lg">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-white">Attach documents</h3>
                  <button
                    type="button"
                    onClick={() => setAttachOpen(false)}
                    className="text-slate-400 hover:text-white text-2xl leading-none cursor-pointer"
                  >
                    ×
                  </button>
                </div>
                <input
                  className="input mb-3"
                  placeholder="Filter documents…"
                  value={attachFilter}
                  onChange={(e) => setAttachFilter(e.target.value)}
                />
                <div className="max-h-72 overflow-y-auto space-y-1">
                  {libraryDocs
                    .filter((d) =>
                      d.label.toLowerCase().includes(attachFilter.toLowerCase())
                    )
                    .map((d) => {
                      const checked = attached.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() =>
                            setAttached((a) =>
                              checked ? a.filter((x) => x !== d.id) : [...a, d.id]
                            )
                          }
                          className={`w-full text-left flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer ${
                            checked
                              ? "border-orange-500 bg-orange-500/10 text-orange-200"
                              : "border-slate-800 text-slate-300 hover:border-slate-600"
                          }`}
                        >
                          <span>{checked ? "☑" : "☐"}</span> 📄 {d.label}
                        </button>
                      );
                    })}
                </div>
                <div className="flex justify-end mt-4">
                  <button
                    type="button"
                    onClick={() => setAttachOpen(false)}
                    className="btn-primary"
                  >
                    Done{attached.length > 0 ? ` (${attached.length})` : ""}
                  </button>
                </div>
              </div>
            </div>
          )}
          {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
          {state?.ok && <p className="text-sm text-emerald-400">{state.ok}</p>}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={pending}>
              {pending ? "Sending…" : "Send email"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="btn-secondary">
              {state?.ok ? "Close" : "Cancel"}
            </button>
          </div>
        </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
