"use client";

import { useState, useActionState } from "react";
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
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [state, formAction, pending] = useActionState<SendEmailState | undefined, FormData>(
    sendEmailAction,
    undefined
  );

  function applyTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (t) {
      setSubject(t.subject);
      setBody(textToHtml(t.body));
    }
  }

  return (
    <details className="card group">
      <summary className="font-semibold cursor-pointer select-none">
        ✉️ Send email
      </summary>

      {!smtpConfigured ? (
        <p className="text-sm text-slate-400 mt-3">
          Email sending isn&apos;t configured yet — add your SMTP details in{" "}
          <Link href="/settings" className="text-orange-400 hover:underline">
            Settings → Email
          </Link>
          .
        </p>
      ) : (
        <form action={formAction} className="mt-4 space-y-3">
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
          {libraryDocs.length > 0 && (
            <div>
              <label className="label">Attach from library</label>
              <div className="grid sm:grid-cols-2 gap-1.5">
                {libraryDocs.map((d) => (
                  <label
                    key={d.id}
                    className="flex items-center gap-2 text-sm text-slate-300 rounded-lg border border-slate-800 px-3 py-1.5 cursor-pointer hover:border-slate-600"
                  >
                    <input type="checkbox" name="attach" value={d.id} className="h-4 w-4" />
                    📄 {d.label}
                  </label>
                ))}
              </div>
            </div>
          )}
          {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
          {state?.ok && <p className="text-sm text-emerald-400">{state.ok}</p>}
          <button className="btn-primary" disabled={pending}>
            {pending ? "Sending…" : "Send email"}
          </button>
        </form>
      )}
    </details>
  );
}
