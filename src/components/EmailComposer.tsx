"use client";

import { useState, useEffect, useActionState, useRef } from "react";
import AiCheckButton from "@/components/AiCheckButton";
import ModalPortal from "@/components/ui/modal-portal";
import Link from "next/link";
import { checkComposerEmail, composerBannerChoices, previewComposerEmail, sendEmailAction, type SendEmailState } from "@/app/actions/emails";
import { SECURE_LINK_DAYS, SECURE_LINK_DEFAULT_DAYS } from "@/lib/secureLinks";
import { secureLinkHint } from "@/lib/sendCheck";
import DealField from "@/components/DealField";
import type { DealOption } from "@/lib/customerTimeline";
import type { ComposerQuote } from "@/lib/composerQuotes";
import RichTextEditor from "@/components/RichTextEditor";
import EmailRibbon from "@/components/EmailRibbon";
import type { Editor } from "@tiptap/react";
import { FileText, Paperclip, Receipt, Send, X } from "lucide-react";
import { EMAIL_UPLOAD_MAX_BYTES, EMAIL_UPLOAD_MAX_FILES } from "@/lib/emailUploads";

const RIBBON_TEXT_BUTTON = "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-40";
const RIBBON_SELECT = "h-8 max-w-48 rounded-md border border-white/10 bg-slate-900 px-2 text-xs text-slate-100";
const ADDRESS_INPUT = "min-w-0 flex-1 border-0 border-b border-white/10 bg-transparent px-1 py-1 text-sm text-white outline-none focus:border-orange-500";

/** One of Outlook's header rows: a boxed label, then the field. */
function AddressRow({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="w-16 shrink-0 rounded-md border border-white/15 px-2 py-1 text-center text-xs text-slate-300">{label}</span>
      {children}
    </div>
  );
}

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
  deals = [],
  quotes = [],
  aiConfigured = false,
  defaultReplyTo = "",
}: {
  /** The customer's open deals, on a customer's page (lib/customerTimeline.dealChoice). */
  deals?: readonly DealOption[];
  /**
   * This customer's quotes the sender may email (lib/composerQuotes.ts). Attaching
   * one sends the same PDF "Email quote" does, and a draft is marked sent once the
   * email has gone. Empty — no quotes, or a role that can't send them — shows nothing.
   */
  quotes?: ComposerQuote[];
  defaultTo: string;
  templates: RenderedTemplate[];
  smtpConfigured: boolean;
  leadId?: string;
  contactId?: string;
  revalidate: string;
  /** `label` is what the sender sees; `fileName` is the stored file's own name — what the customer receives and what the send check reads. */
  libraryDocs?: { id: string; label: string; fileName: string }[];
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
  // The signature banners this person may send with (Settings → Signature banners), default first.
  // Fetched when the composer opens; none means no picker at all.
  const [banners, setBanners] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    composerBannerChoices().then((list) => alive && setBanners(list), () => {});
    return () => { alive = false; };
  }, [open]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attached, setAttached] = useState<string[]>([]);
  const [attachFilter, setAttachFilter] = useState("");
  const [attachedQuotes, setAttachedQuotes] = useState<string[]>([]);
  const pickedQuotes = quotes.filter((q) => attachedQuotes.includes(q.id));
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
    // The FILE's name, not the library title: the server checks the file name when it sends, and a title
    // that reads harmlessly ("Customer paperwork") over a file called "ID copy.pdf" would pass here and be
    // refused there, with no way to confirm.
    ...attached.map((id) => ({ name: libraryDocs.find((x) => x.id === id)?.fileName ?? "Document", sizeBytes: 0 })),
    ...uploads.map((f) => ({ name: f.name, sizeBytes: f.size })),
    ...pickedQuotes.map((q) => ({ name: q.fileName, sizeBytes: 0 })),
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
      setPreviewError("");
      const { warning: found, error: blocked } = await checkComposerEmail({
        to: String(data.get("to") ?? ""),
        cc: String(data.get("cc") ?? ""),
        bcc: String(data.get("bcc") ?? ""),
        subject: String(data.get("subject") ?? ""),
        bodyHtml: body,
        contactId,
        leadId,
        fileNames: allFiles.map((f) => f.name),
        secureLinks: secure && allFiles.length > 0,
      });
      if (blocked) {
        // Cannot go as written (no private store for a secure link): say so here, with the form intact.
        setPreview(null);
        setPreviewError(blocked);
        return;
      }
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
  // YOUR SIGNATURE under the message while you write, as in Outlook (Sean, 2026-10-15) — built by the server exactly
  // as Send adds it (Preview's builder, with no message), and again when the banner or the recipient changes, since
  // a customer who opted out of marketing gets no banner. Shown, not editable: it is added when the email goes.
  const [signatureHtml, setSignatureHtml] = useState("");
  const [signatureHeight, setSignatureHeight] = useState(0);
  const signatureAsk = useRef(0);
  function loadSignature() {
    const form = formRef.current;
    const field = (name: string) => String((form ? new FormData(form).get(name) : null) ?? "").trim();
    const ask = ++signatureAsk.current;
    previewComposerEmail("", { to: field("to"), contactId, leadId, choice: field("banner") }).then(
      ({ html }) => { if (ask === signatureAsk.current) setSignatureHtml(html); },
      () => {},
    );
  }
  useEffect(() => {
    if (open) loadSignature();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening; the fields reload it themselves
  }, [open]);
  // `sentState` is the send result the preview was opened against: once a send
  // answers (sent, or an error to read on the form), the preview steps aside.
  const [preview, setPreview] = useState<{ html: string; to: string; cc: string; bcc: string; replyTo: string; sentState: typeof state } | null>(null);
  // The editor, for the ribbon above the address rows (Outlook's layout puts the formatting at the top).
  const [editor, setEditor] = useState<Editor | null>(null);
  const [showBcc, setShowBcc] = useState(false);
  const [showReplyTo, setShowReplyTo] = useState(false);
  // A pasted or chosen picture that could not be used: said under the message, never in a browser pop-up.
  const [imageProblem, setImageProblem] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  async function showPreview() {
    const field = (name: string) => String(new FormData(formRef.current ?? undefined).get(name) ?? "").trim();
    setPreviewing(true);
    setPreviewError("");
    try {
      // Who it is going to decides whether the signature banner shows (a customer who opted out of marketing gets none).
      // Files going as secure links are shown where they will sit in the email (the links are only made on Send).
      const { html } = await previewComposerEmail(
        body,
        { to: field("to"), contactId, leadId, choice: field("banner") },
        secure && allFiles.length > 0 ? { files: allFiles, days } : undefined,
      );
      setPreview({ html, to: field("to"), cc: field("cc"), bcc: field("bcc"), replyTo: field("replyTo"), sentState: state });
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
        {/*
          OUTLOOK'S LAYOUT (Sean, 2026-10-15: "Can we not build this as our email
          editor? I find this one is so hard to work with"): nearly the whole
          screen; the ribbon along the top; Send on the left of compact To / Cc /
          Subject rows; attachments as chips under them; then the message on a
          white page — what the customer will see — using all the height left.
        */}
        <div
          className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-0 sm:p-3"
          onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="flex h-full w-full max-w-[1500px] flex-col overflow-hidden border border-white/10 bg-card shadow-2xl sm:rounded-xl">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
              <h2 className="truncate text-sm font-semibold text-white">{subject.trim() || "New email"}</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="grid size-8 place-items-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            {!smtpConfigured ? (
              <p className="p-6 text-sm text-slate-400">
                Email sending isn&apos;t configured yet — add your SMTP details in{" "}
                <Link href="/settings?tab=email" className="text-orange-400 hover:underline">
                  Settings → Email
                </Link>
                .
              </p>
            ) : (
              <form ref={formRef} action={formAction} onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          {/* "1" once the sender has read the sensitive-data warning and chosen to send anyway. */}
          <input ref={confirmedRef} type="hidden" name="sensitiveOk" defaultValue="" />
          {leadId && <input type="hidden" name="leadId" value={leadId} />}
          {contactId && <input type="hidden" name="contactId" value={contactId} />}
          <input type="hidden" name="revalidate" value={revalidate} />

          <EmailRibbon
            // Built afresh once the editor exists: its state hook is bound to the editor it first sees, and a
            // ribbon first drawn before the editor was ready stayed an empty strip until something was typed.
            key={editor ? "ready" : "waiting"}
            editor={editor}
            onImageProblem={setImageProblem}
            insert={
              <>
                <button type="button" onClick={() => uploadRef.current?.click()} className={RIBBON_TEXT_BUTTON} title={`Attach a file from your computer — up to ${EMAIL_UPLOAD_MAX_FILES} files, ${EMAIL_UPLOAD_MAX_BYTES / 1024 / 1024} MB in total`}>
                  <Paperclip className="size-4" />Attach file
                </button>
                <button type="button" onClick={() => setAttachOpen(true)} className={RIBBON_TEXT_BUTTON} disabled={libraryDocs.length === 0} title="Attach a document from the library">
                  <FileText className="size-4" />Library
                </button>
                {quotes.filter((q) => !attachedQuotes.includes(q.id)).map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => setAttachedQuotes((a) => [...a, q.id])}
                    className={RIBBON_TEXT_BUTTON}
                    title={q.draft ? "Attaches the quote PDF. The quote is marked sent when the email goes." : "Attaches the quote PDF."}
                  >
                    <Receipt className="size-4" />Quote {q.label}
                  </button>
                ))}
              </>
            }
            options={
              <>
                <select className={RIBBON_SELECT} defaultValue="" onChange={(e) => applyTemplate(e.target.value)} aria-label="Template" title="Start from a template">
                  <option value="">Template…</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                {banners.length > 0 && (
                  <select
                    name="banner"
                    className={RIBBON_SELECT}
                    defaultValue=""
                    aria-label="Marketing banner"
                    onChange={loadSignature}
                    title="The marketing banner under your signature. A customer who opted out of marketing never gets one, whatever is chosen. Preview shows what goes out."
                  >
                    <option value="">Banner: {banners[0].name}</option>
                    {banners.slice(1).map((banner) => (
                      <option key={banner.id} value={banner.id}>Banner: {banner.name}</option>
                    ))}
                    <option value="none">No banner</option>
                  </select>
                )}
              </>
            }
          />

          {/* SEND on the left of the address rows, as in Outlook. */}
          <div className="flex gap-3 border-b border-white/10 px-3 py-2.5">
            <button
              className="flex w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-lg bg-orange-600 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-60"
              disabled={pending || checking}
            >
              <Send className="size-5" />
              {pending ? "Sending…" : checking ? "Checking…" : "Send"}
            </button>
            <div className="min-w-0 flex-1 space-y-1.5">
              <AddressRow label="To">
                {/* A list, as in Outlook: the server checks every address (parseAddressList). */}
                <input name="to" type="text" className={ADDRESS_INPUT} required defaultValue={defaultTo} autoComplete="off" spellCheck={false} placeholder="name@example.com, …" onBlur={loadSignature} />
              </AddressRow>
              <AddressRow label="Cc">
                <input name="cc" type="text" className={ADDRESS_INPUT} autoComplete="off" spellCheck={false} />
                {!showBcc && <button type="button" className="shrink-0 text-xs text-slate-400 hover:text-white" onClick={() => setShowBcc(true)}>Bcc</button>}
                {!showReplyTo && <button type="button" className="shrink-0 text-xs text-slate-400 hover:text-white" onClick={() => setShowReplyTo(true)} title={`Replies go to: ${defaultReplyTo || "the workspace address"}`}>Reply to</button>}
              </AddressRow>
              {/* Hidden, not removed, until asked for: a value typed in stays when the row is folded away again. */}
              <AddressRow label="Bcc" className={showBcc ? "" : "hidden"}>
                <input name="bcc" type="text" className={ADDRESS_INPUT} autoComplete="off" spellCheck={false} />
              </AddressRow>
              <AddressRow label="Reply to" className={showReplyTo ? "" : "hidden"}>
                <input
                  name="replyTo"
                  className={ADDRESS_INPUT}
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
                  title="Where the customer's reply goes. The CRM mailbox keeps the reply on this record, and yours puts it in your normal inbox. Clear it to send replies to the workspace address only."
                />
              </AddressRow>
              <AddressRow label="Subject">
                <input name="subject" className={ADDRESS_INPUT} required value={subject} onChange={(e) => setSubject(e.target.value)} />
              </AddressRow>
              {/* On a customer's page: which of their deals this email is about (asked only when there are several). */}
              {!leadId && deals.length > 0 && <div className="pt-1"><DealField deals={deals} id="email-deal" /></div>}
            </div>
          </div>

          {/* ATTACHMENTS as chips under the subject, as in Outlook. */}
          <div className={allFiles.length > 0 ? "border-b border-white/10 px-3 py-2" : "hidden"}>
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
              {pickedQuotes.map((q) => (
                <span key={q.id} className="badge bg-slate-800 text-slate-200 gap-1.5 py-1" data-testid="attached-quote">
                  🧾 {q.fileName}
                  <button
                    type="button"
                    onClick={() => setAttachedQuotes((a) => a.filter((x) => x !== q.id))}
                    className="text-slate-500 hover:text-red-400 cursor-pointer"
                    aria-label={`Remove ${q.fileName}`}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            {attached.map((id) => (
              <input key={id} type="hidden" name="attach" value={id} />
            ))}
            {pickedQuotes.map((q) => (
              <input key={q.id} type="hidden" name="attachQuote" value={q.id} />
            ))}
            {pickedQuotes.some((q) => q.draft) && (
              <p className="mt-1 text-xs text-amber-300" data-testid="quote-will-be-sent">
                {pickedQuotes.filter((q) => q.draft).map((q) => q.label).join(", ")} {pickedQuotes.filter((q) => q.draft).length === 1 ? "is a draft and" : "are drafts and"} will be marked sent when this email goes. After that, changes need a revision.
              </p>
            )}
            {allFiles.length > 0 && (
              <div className="mt-2">
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
          {/* The form posts this input's files; it always holds exactly the chips above. Opened from Insert → Attach file. */}
          <input
            ref={uploadRef}
            type="file"
            name="upload"
            multiple
            className="hidden"
            onChange={(e) => setUploadFiles([...uploads, ...Array.from(e.target.files ?? [])])}
          />

          {/* THE MESSAGE, on a white page: what the customer sees. It takes all the height that is left. */}
          <div
            className="min-h-0 flex-1 cursor-text overflow-y-auto bg-white"
            // A click anywhere on the white page — below the last line too — puts the cursor in the message, as in Outlook.
            onMouseDown={(event) => {
              const target = event.target as HTMLElement;
              if (!editor || target.closest(".ProseMirror, a, button, input")) return;
              event.preventDefault();
              editor.chain().focus("end").run();
            }}
          >
            <input type="hidden" name="bodyHtml" value={body} />
            <RichTextEditor
              value={body}
              onChange={setBody}
              emailTools
              appearance="page"
              showToolbar={false}
              pasteImages
              onImageProblem={setImageProblem}
              onEditorReady={setEditor}
              placeholder="Write your message — paste a screenshot with Ctrl+V"
            />
            {signatureHtml && (
              // No scripts (no allow-scripts); same origin only so its height can be read. Clicks pass to the page.
              <iframe
                title="Your signature"
                sandbox="allow-same-origin"
                srcDoc={signatureHtml}
                className="pointer-events-none block w-full border-0 px-4 sm:px-8"
                style={{ height: signatureHeight }}
                onLoad={(event) => setSignatureHeight(event.currentTarget.contentDocument?.documentElement.scrollHeight ?? 0)}
              />
            )}
            <p className="px-6 pb-6 text-xs text-slate-400 sm:px-10">
              Your signature{banners.length > 0 ? " and banner are" : " is"} added like this when it is sent — Preview shows the whole email.{" "}
              <Link href="/settings?tab=team" className="text-blue-600 hover:underline">Edit your signature</Link>
            </p>
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
                  {preview.cc && (
                    <>
                      <dt className="text-slate-500">Cc</dt>
                      <dd className="text-slate-200 break-all">{preview.cc}</dd>
                    </>
                  )}
                  {/* Bcc is shown to the sender only — it is not in the email the others receive. */}
                  {preview.bcc && (
                    <>
                      <dt className="text-slate-500">Bcc</dt>
                      <dd className="text-slate-200 break-all">{preview.bcc} <span className="text-slate-500">(not shown to the others)</span></dd>
                    </>
                  )}
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
          {/* The foot of the window: anything to read before it goes, and the secondary actions. Send is top left. */}
          <div className="space-y-2 border-t border-white/10 px-3 py-2.5">
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
          {imageProblem && <p className="text-sm text-amber-300">{imageProblem} <button type="button" className="underline" onClick={() => setImageProblem("")}>OK</button></p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={showPreview} className="btn-secondary btn-sm" disabled={previewing || pending}>
              {previewing ? "Building preview…" : "👁 Preview"}
            </button>
            <AiCheckButton
              getDraft={() => body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}
              contactId={contactId}
              leadId={leadId}
              configured={aiConfigured}
            />
            <button type="button" onClick={() => setOpen(false)} className="btn-secondary btn-sm ml-auto">
              {state?.ok ? "Close" : "Discard"}
            </button>
          </div>
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
