"use client";

import { useState, useEffect, useActionState, useRef } from "react";
import AiCheckButton from "@/components/AiCheckButton";
import ModalPortal from "@/components/ui/modal-portal";
import Link from "next/link";
import { checkComposerEmail, previewComposerEmail, sendEmailAction, type SendEmailState } from "@/app/actions/emails";
import { SECURE_LINK_DAYS, SECURE_LINK_DEFAULT_DAYS } from "@/lib/secureLinks";
import { secureLinkHint } from "@/lib/sendCheck";
import RichTextEditor from "@/components/RichTextEditor";
import { EMAIL_UPLOAD_MAX_BYTES, EMAIL_UPLOAD_MAX_FILES } from "@/lib/emailUploads";

const fileSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

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
  aiConfigured = false,
  defaultReplyTo = "",
}: {
  defaultTo: string;
  templates: RenderedTemplate[];
  smtpConfigured: boolean;
  leadId?: string;
  contactId?: string;
  revalidate: string;
  libraryDocs?: { id: string; label: string }[];
  aiConfigured?: boolean;
  /**
   * Pre-filled Reply-To — the sender plus the CRM's own mailbox, resolved by
   * `composerReplyToDefault`. Defaulted to "" so a caller that has not been
   * updated renders an empty field rather than `undefined`, and mail from that
   * screen behaves exactly as it did before this field existed.
   */
  defaultReplyTo?: string;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [attached, setAttached] = useState<string[]>([]);
  const [attachFilter, setAttachFilter] = useState("");
  // Files from the computer. The hidden file input is what the form posts, so it
  // is rebuilt to hold exactly this list whenever a file is added or removed.
  const [uploads, setUploads] = useState<File[]>([]);
  const uploadRef = useRef<HTMLInputElement>(null);
  const setUploadFiles = (picked: File[]) => {
    // The same file (name, size, date) once: picking it again, or a second
    // change event for one pick, never doubles it up.
    const seen = new Set<string>();
    const files = picked.filter((f) => {
      const key = `${f.name}:${f.size}:${f.lastModified}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setUploads(files);
    if (!uploadRef.current) return;
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    uploadRef.current.files = dt.files;
  };
  const [state, formAction, pending] = useActionState<SendEmailState | undefined, FormData>(
    sendEmailAction,
    undefined
  );

  // Secure links: send the files as expiring, recallable links instead of attachments (lib/secureLinks.ts).
  const [secure, setSecure] = useState(false);
  const [days, setDays] = useState<number>(SECURE_LINK_DEFAULT_DAYS);
  const allFiles = [
    ...attached.map((id) => ({ name: libraryDocs.find((x) => x.id === id)?.label ?? "Document", sizeBytes: 0 })),
    ...uploads.map((f) => ({ name: f.name, sizeBytes: f.size })),
  ];
  const linkHint = secureLinkHint(allFiles.map((f) => f.name), secure);

  /*
   * The check before it goes (lib/sendCheck.ts). Asked when Send is pressed, and
   * BEFORE the form is submitted — a submitted form is reset, which would drop
   * the chosen files and the typed address, so a warning shown after a round trip
   * would be a warning about an email the sender could no longer send as written.
   * The server asks the same question again and refuses an unconfirmed send.
   */
  const [warning, setWarning] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const passCheck = useRef(false);
  const confirmedRef = useRef<HTMLInputElement>(null);
  const submitNow = (confirmed: boolean) => {
    if (confirmedRef.current) confirmedRef.current.value = confirmed ? "1" : "";
    passCheck.current = true;
    setWarning(null);
    formRef.current?.requestSubmit();
  };
  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (passCheck.current) {
      passCheck.current = false;
      return; // checked (or confirmed): let the form go
    }
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setChecking(true);
    try {
      const { warning: found } = await checkComposerEmail({
        to: String(data.get("to") ?? ""),
        subject: String(data.get("subject") ?? ""),
        bodyHtml: body,
        contactId,
        leadId,
        fileNames: allFiles.map((f) => f.name),
        secureLinks: secure && allFiles.length > 0,
      });
      if (found) {
        setPreview(null);
        setWarning(found);
        return;
      }
    } catch {
      // The check could not run; the server will make it again and refuse if it must.
    } finally {
      setChecking(false);
    }
    submitNow(false);
  }

  // Preview: the server builds the same HTML the send does (message + signature).
  const formRef = useRef<HTMLFormElement>(null);
  // `sentState` is the send result the preview was opened against: once a send
  // answers (sent, or an error to read on the form), the preview steps aside.
  const [preview, setPreview] = useState<{ html: string; to: string; replyTo: string; sentState: typeof state } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  async function showPreview() {
    const field = (name: string) => String(new FormData(formRef.current ?? undefined).get(name) ?? "").trim();
    setPreviewing(true);
    setPreviewError("");
    try {
      // Files going as secure links are shown where they will sit in the email (the links are only made on Send).
      const { html } = await previewComposerEmail(body, secure && allFiles.length > 0 ? { files: allFiles, days } : undefined);
      setPreview({ html, to: field("to"), replyTo: field("replyTo"), sentState: state });
    } catch {
      setPreviewError("Couldn't build the preview — try again.");
    } finally {
      setPreviewing(false);
    }
  }
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
        <ModalPortal>
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
              <form ref={formRef} action={formAction} onSubmit={onSubmit} className="space-y-3">
          {/* "1" once the sender has read the sensitive-data warning and chosen to send anyway. */}
          <input ref={confirmedRef} type="hidden" name="sensitiveOk" defaultValue="" />
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
            <label className="label" htmlFor="email-reply-to">
              Reply to
            </label>
            <input
              id="email-reply-to"
              name="replyTo"
              className="input"
              defaultValue={defaultReplyTo}
              placeholder="you@example.com, crm@example.com"
              // NOT type="email". That input type validates a SINGLE address, so
              // the browser would reject the two-address default this field exists
              // to provide. The server validates the list — see parseReplyTo — and
              // it is the server's answer that matters, since the value reaches a
              // mail header.
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="email-reply-to-hint"
            />
            <p id="email-reply-to-hint" className="mt-1 text-xs text-slate-400">
              Where the customer&apos;s reply goes. Separate several with commas — the CRM mailbox
              keeps the reply on this record, and yours puts it in your normal inbox. Clear it to
              send replies to the workspace address only.
            </p>
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
            <RichTextEditor value={body} onChange={setBody} emailTools />
            <AiCheckButton
              getDraft={() => body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}
              contactId={contactId}
              leadId={leadId}
              configured={aiConfigured}
            />
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
              {uploads.map((file, i) => (
                <span key={`${file.name}-${i}`} className="badge bg-slate-800 text-slate-200 gap-1.5 py-1">
                  📎 {file.name} <span className="text-slate-500">{fileSize(file.size)}</span>
                  <button
                    type="button"
                    onClick={() => setUploadFiles(uploads.filter((_, j) => j !== i))}
                    className="text-slate-500 hover:text-red-400 cursor-pointer"
                    aria-label={`Remove ${file.name}`}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => setAttachOpen(true)}
                className="btn-secondary btn-sm"
                disabled={libraryDocs.length === 0}
              >
                📎 Attach from library
              </button>
              <button type="button" onClick={() => uploadRef.current?.click()} className="btn-secondary btn-sm">
                ⬆ Upload a file
              </button>
              {/* The form posts this input's files; it always holds exactly the chips above. */}
              <input
                ref={uploadRef}
                type="file"
                name="upload"
                multiple
                className="hidden"
                onChange={(e) => setUploadFiles([...uploads, ...Array.from(e.target.files ?? [])])}
              />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Up to {EMAIL_UPLOAD_MAX_FILES} files from your computer, {EMAIL_UPLOAD_MAX_BYTES / 1024 / 1024} MB in total.
            </p>
            {attached.map((id) => (
              <input key={id} type="hidden" name="attach" value={id} />
            ))}
            {allFiles.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-800 p-3">
                <label className="flex items-start gap-2 text-sm text-slate-200">
                  <input type="checkbox" name="secureLinks" checked={secure} onChange={(e) => setSecure(e.target.checked)} className="mt-0.5" />
                  <span>
                    Send {allFiles.length === 1 ? "this file" : "these files"} as a secure link, not an attachment
                    <span className="block text-xs text-slate-500">
                      The customer gets a link to download {allFiles.length === 1 ? "it" : "them"}. It stops working on the date you choose, you can
                      recall it from this record, and you are told when it is first downloaded. Use it for ID copies, bank and finance documents.
                    </span>
                  </span>
                </label>
                {secure && (
                  <label className="mt-2 flex items-center gap-2 pl-6 text-xs text-slate-400">
                    Link works for
                    <select name="secureDays" className="input w-auto py-1 text-xs" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                      {SECURE_LINK_DAYS.map((d) => (
                        <option key={d} value={d}>{d === 1 ? "1 day" : `${d} days`}</option>
                      ))}
                    </select>
                  </label>
                )}
                {linkHint && <p className="mt-2 text-xs text-amber-300">{linkHint}</p>}
              </div>
            )}
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
          {preview && preview.sentState === state && (
            <div
              className="fixed inset-0 z-[60] flex items-start justify-center bg-black/70 p-4 pt-8 overflow-y-auto"
              onPointerDown={(e) => e.target === e.currentTarget && setPreview(null)}
            >
              <div className="card w-full max-w-3xl">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-white">Preview — what the customer receives</h3>
                  <button
                    type="button"
                    onClick={() => setPreview(null)}
                    className="text-slate-400 hover:text-white text-2xl leading-none cursor-pointer"
                    aria-label="Back to editing"
                  >
                    ×
                  </button>
                </div>
                <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-slate-500">To</dt>
                  <dd className="text-slate-200 break-all">{preview.to || "—"}</dd>
                  {preview.replyTo && (
                    <>
                      <dt className="text-slate-500">Reply to</dt>
                      <dd className="text-slate-200 break-all">{preview.replyTo}</dd>
                    </>
                  )}
                  <dt className="text-slate-500">Subject</dt>
                  <dd className="text-slate-200">{subject || "—"}</dd>
                  {(attached.length > 0 || uploads.length > 0) && (
                    <>
                      <dt className="text-slate-500">Attached</dt>
                      <dd className="text-slate-200">
                        {[...attached.map((id) => libraryDocs.find((x) => x.id === id)?.label ?? "Document"), ...uploads.map((f) => f.name)].join(", ")}
                      </dd>
                    </>
                  )}
                </dl>
                {/* sandbox="": the message renders as HTML but can run nothing. */}
                <iframe
                  title="Email preview"
                  sandbox=""
                  srcDoc={preview.html}
                  className="h-[60vh] w-full rounded-lg border border-slate-700 bg-white"
                />
                <div className="mt-4 flex gap-2">
                  <button className="btn-primary" disabled={pending}>
                    {pending ? "Sending…" : "Send email"}
                  </button>
                  <button type="button" onClick={() => setPreview(null)} className="btn-secondary">
                    Back to editing
                  </button>
                </div>
              </div>
            </div>
          )}
          {warning && (
            <div role="alertdialog" aria-labelledby="send-warning-title" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
              <p id="send-warning-title" className="text-sm font-semibold text-amber-200">Check before you send</p>
              <p className="mt-1 text-sm text-amber-100">{warning}</p>
              <p className="mt-1 text-xs text-amber-200/80">
                Nothing has been sent. If the address is right, you can send it. If it holds a personal document, a secure link is safer than an attachment: it expires and can be recalled.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="btn-secondary btn-sm" onClick={() => setWarning(null)}>Go back and change it</button>
                <button type="button" className="btn-primary btn-sm" onClick={() => submitNow(true)} disabled={pending}>Send anyway</button>
              </div>
            </div>
          )}
          {state?.error && <p className="text-sm text-red-400">{state.error}</p>}
          {state?.ok && <p className="text-sm text-emerald-400">{state.ok}</p>}
          {previewError && <p className="text-sm text-red-400">{previewError}</p>}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={pending || checking}>
              {pending ? "Sending…" : checking ? "Checking…" : "Send email"}
            </button>
            <button type="button" onClick={showPreview} className="btn-secondary" disabled={previewing || pending}>
              {previewing ? "Building preview…" : "👁 Preview"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="btn-secondary">
              {state?.ok ? "Close" : "Cancel"}
            </button>
          </div>
        </form>
            )}
          </div>
        </div>
        </ModalPortal>
      )}
    </>
  );
}
