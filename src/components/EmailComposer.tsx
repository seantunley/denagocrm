"use client";

import { useState, useEffect, useActionState, useRef } from "react";
import { flushSync } from "react-dom";
import AiCheckButton from "@/components/AiCheckButton";
import ModalPortal from "@/components/ui/modal-portal";
import Link from "next/link";
import { checkComposerEmail, composerBannerChoices, discardEmailDraft, openEmailDraft, previewComposerEmail, saveEmailDraft, sendEmailAction, type SendEmailState } from "@/app/actions/emails";
import EmailWaitingList from "@/components/EmailWaitingList";
import { localInputValue, nextHalfHour, quickSendTimes } from "@/lib/emailSchedule";
import { SECURE_LINK_DAYS, SECURE_LINK_DEFAULT_DAYS } from "@/lib/secureLinks";
import { secureLinkHint } from "@/lib/sendCheck";
import DealField from "@/components/DealField";
import type { DealOption } from "@/lib/customerTimeline";
import type { ComposerQuote } from "@/lib/composerQuotes";
import RichTextEditor from "@/components/RichTextEditor";
import EmailRibbon from "@/components/EmailRibbon";
import type { Editor } from "@tiptap/react";
import { Clock, FileText, Paperclip, Receipt, Send, X } from "lucide-react";
import { EMAIL_UPLOAD_MAX_BYTES, EMAIL_UPLOAD_MAX_FILES } from "@/lib/emailUploads";
import { COMPOSE_REPLY_EVENT, replyDraft, type ComposeReplyDetail } from "@/lib/emailReply";
import { formatDateTime } from "@/lib/format";

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
  // Secure links: send the files as expiring, recallable links instead of attachments (lib/secureLinks.ts).
  const [secure, setSecure] = useState(false);
  const [days, setDays] = useState<number>(SECURE_LINK_DEFAULT_DAYS);
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
  // DRAFTS (lib/emailDrafts.ts, Sean 2026-10-15): what is written is kept as a draft as it is written, so closing
  // the composer or the tab loses nothing. `draftId` is this email's draft; it is posted with Send, which ends it.
  const draftIdRef = useRef<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState("");
  const [waitingKey, setWaitingKey] = useState(0);
  const adoptDraft = (id: string | null) => {
    draftIdRef.current = id;
    setDraftId(id);
    setSavedAt("");
  };
  // SCHEDULE SEND: `sendAt` is posted only when Schedule was pressed (scheduling); Send clears it.
  // The time, as STATE, posted in a controlled hidden field — never written into the field directly, which React
  // resets on its next render. `schedulingRef` is the sender's intent, read where the form is let go (onSubmit).
  const [sendAt, setSendAt] = useState("");
  const schedulingRef = useRef(false);
  const sendNow = () => {
    schedulingRef.current = false;
    flushSync(() => {
      setSendAt("");
      setScheduling(false);
    });
  };
  const [scheduling, setScheduling] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [laterAt, setLaterAt] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [state, formAction, pending] = useActionState<SendEmailState | undefined, FormData>(
    async (previous, form) => {
      const result = await sendEmailAction(previous, form);
      schedulingRef.current = false;
      setScheduling(false);
      setSendAt("");
      if (result.ok) {
        // Sent or scheduled: the draft is done with, and the page is ready for the next email.
        adoptDraft(null);
        setSubject("");
        setBody("");
        setAttached([]);
        setAttachedQuotes([]);
        setUploadFiles([]);
        setScheduleOpen(false);
        setWaitingKey((key) => key + 1);
      }
      return result;
    },
    undefined
  );

  // REPLY / REPLY ALL / FORWARD from an email on the timeline (EmailReplyButtons), or a DRAFT opened again: the
  // composer opens with the addresses filled and — for a reply — the email it answers, so it threads in their
  // mailbox. Tied to the send result it was opened against (as the preview is): once that email has gone, it
  // lapses, and the next email is not quietly copied to the last one's Cc.
  const [reply, setReply] = useState<{ to: string; cc: string; bcc?: string; replyTo?: string; inReplyTo: string; sentState: typeof state } | null>(null);
  const replying = reply && reply.sentState === state ? reply : null;
  useEffect(() => {
    const onReply = (event: Event) => {
      const { email, kind } = (event as CustomEvent<ComposeReplyDetail>).detail;
      const draft = replyDraft(email, kind, { customer: defaultTo, when: formatDateTime(email.occurredAt) });
      setReply({ to: kind === "forward" ? "" : defaultTo, cc: draft.cc, inReplyTo: kind === "forward" ? "" : email.id, sentState: state });
      adoptDraft(null);
      setSubject(draft.subject);
      setBody(draft.html);
      setOpen(true);
    };
    window.addEventListener(COMPOSE_REPLY_EVENT, onReply);
    return () => window.removeEventListener(COMPOSE_REPLY_EVENT, onReply);
  }, [defaultTo, state]);

  /** Open a draft — or take back a scheduled send of yours to edit it. A problem to show, if it can't. */
  async function openDraft(id: string): Promise<string | undefined> {
    const opened = await openEmailDraft(id);
    if (!opened.draft) return opened.error ?? "That draft could not be opened.";
    const d = opened.draft;
    setReply({ to: d.to, cc: d.cc, bcc: d.bcc, replyTo: d.replyTo, inReplyTo: d.inReplyToId ?? "", sentState: state });
    if (d.bcc) setShowBcc(true);
    if (d.replyTo !== defaultReplyTo) setShowReplyTo(true);
    setSubject(d.subject);
    setBody(d.bodyHtml);
    setAttached(d.attachIds.filter((id) => libraryDocs.some((doc) => doc.id === id)));
    setAttachedQuotes(d.quoteIds.filter((id) => quotes.some((q) => q.id === id)));
    setUploadFiles([]);
    setSecure(d.secureLinks);
    if (d.secureDays) setDays(d.secureDays);
    adoptDraft(d.id);
    if (opened.filesDropped?.length) setImageProblem(`Files from your computer are not kept with a draft — attach again: ${opened.filesDropped.join(", ")}.`);
    setOpen(true);
    return undefined;
  }

  // AUTOSAVE: a moment after the last change. Nothing is kept for an empty email.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function queueSave() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveDraftNow(), 1500);
  }
  // What is written NOW — read by a save however it was started (a timer, or an Escape handler bound when the
  // composer opened), so it never keeps an older version of the email.
  const written = useRef<{ subject: string; body: string; attached: string[]; attachedQuotes: string[]; secure: boolean; days: number; inReplyTo: string; pending: boolean } | null>(null);
  useEffect(() => {
    written.current = { subject, body, attached, attachedQuotes, secure, days, inReplyTo: replying?.inReplyTo ?? "", pending };
  });
  async function saveDraftNow() {
    const form = formRef.current;
    const now = written.current;
    if (!form || !now || now.pending) return;
    if (!now.subject.trim() && !now.body.replace(/<[^>]+>/g, "").trim()) return;
    const data = new FormData(form);
    const field = (name: string) => String(data.get(name) ?? "");
    const saved = await saveEmailDraft(draftIdRef.current, {
      to: field("to"), cc: field("cc"), bcc: field("bcc"), replyTo: field("replyTo"),
      subject: now.subject, bodyHtml: now.body,
      contactId: contactId ?? null, leadId: field("leadId") || leadId || null,
      attachIds: now.attached, quoteIds: now.attachedQuotes,
      banner: field("banner"), secureLinks: now.secure, secureDays: now.days,
      inReplyToId: now.inReplyTo || null,
    }).catch(() => null);
    if (saved?.id) {
      if (saved.id !== draftIdRef.current) setWaitingKey((key) => key + 1);
      draftIdRef.current = saved.id;
      setDraftId(saved.id);
      setSavedAt(formatDateTime(new Date()));
    }
  }
  useEffect(() => {
    if (open) queueSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saves on a change to what is written, not on every render
  }, [subject, body, attached, attachedQuotes, secure, days]);
  /** Close the composer, keeping what is written: a save still waiting is made now, while the form is still there. */
  function closeComposer() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      void saveDraftNow();
    }
    setOpen(false);
  }
  // Escape is bound once per opening; it closes through whatever closeComposer is current.
  const closeRef = useRef(closeComposer);
  useEffect(() => {
    closeRef.current = closeComposer;
  });

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
    // Going now (or being scheduled): no autosave may follow it and keep a draft of an email that has gone.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (passCheck.current) {
      passCheck.current = false;
      // ASKED TO SCHEDULE, SO NEVER SENT NOW. If the time is not in what is about to be posted, stop: an email
      // the sender meant for tomorrow must not reach the customer today. (A time written straight into a hidden
      // field was reset by React's next render — and the email went at once. Found testing it, 2026-10-15.)
      if (schedulingRef.current && !new FormData(event.currentTarget).get("sendAt")) {
        event.preventDefault();
        schedulingRef.current = false;
        setScheduling(false);
        setPreviewError("It could not be scheduled, so nothing was sent. Choose the time and press Schedule send again.");
      }
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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
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
      <EmailWaitingList contactId={contactId} leadId={leadId} revalidate={revalidate} refreshKey={waitingKey} onOpen={openDraft} />

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
          onPointerDown={(e) => e.target === e.currentTarget && closeComposer()}
        >
          <div className="flex h-full w-full max-w-[1500px] flex-col overflow-hidden border border-white/10 bg-card shadow-2xl sm:rounded-xl">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
              <h2 className="truncate text-sm font-semibold text-white">{subject.trim() || "New email"}</h2>
              <button
                type="button"
                onClick={closeComposer}
                className="grid size-8 place-items-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white"
                aria-label="Close"
                title="Close — what you have written is kept as a draft"
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
              <form ref={formRef} action={formAction} onSubmit={onSubmit} onInput={queueSave} className="flex min-h-0 flex-1 flex-col">
          {/* "1" once the sender has read the sensitive-data warning and chosen to send anyway. */}
          <input ref={confirmedRef} type="hidden" name="sensitiveOk" defaultValue="" />
          {/* The draft this email is kept in (ended when it is sent), and — only when Schedule was pressed — when it goes. */}
          <input type="hidden" name="draftId" value={draftId ?? ""} />
          <input type="hidden" name="sendAt" value={sendAt} />
          {/* The timeline email this answers: the server checks it is this customer's and threads the reply to it. */}
          <input type="hidden" name="inReplyTo" value={replying?.inReplyTo ?? ""} />
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

          {/* SEND on the left of the address rows, as in Outlook — and under it, send later. */}
          <div className="flex gap-3 border-b border-white/10 px-3 py-2.5">
            <div className="flex w-20 shrink-0 flex-col gap-1.5">
              <button
                className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg bg-orange-600 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-60"
                disabled={pending || checking}
                onClick={sendNow}
              >
                <Send className="size-5" />
                {pending ? (scheduling ? "Scheduling…" : "Sending…") : checking ? "Checking…" : "Send"}
              </button>
              <button
                type="button"
                onClick={() => setScheduleOpen((shown) => !shown)}
                className={`flex items-center justify-center gap-1 rounded-md border py-1 text-[11px] ${scheduleOpen ? "border-orange-500 text-orange-300" : "border-white/15 text-slate-300 hover:bg-white/10"}`}
                title="Send it later, at a time you choose"
                aria-expanded={scheduleOpen}
              >
                <Clock className="size-3.5" />Later
              </button>
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <AddressRow label="To">
                {/* A list, as in Outlook: the server checks every address (parseAddressList). */}
                <input name="to" type="text" className={ADDRESS_INPUT} required defaultValue={replying ? replying.to : defaultTo} autoComplete="off" spellCheck={false} placeholder="name@example.com, …" />
              </AddressRow>
              <AddressRow label="Cc">
                <input name="cc" type="text" className={ADDRESS_INPUT} defaultValue={replying?.cc ?? ""} autoComplete="off" spellCheck={false} />
                {!showBcc && <button type="button" className="shrink-0 text-xs text-slate-400 hover:text-white" onClick={() => setShowBcc(true)}>Bcc</button>}
                {!showReplyTo && <button type="button" className="shrink-0 text-xs text-slate-400 hover:text-white" onClick={() => setShowReplyTo(true)} title={`Replies go to: ${defaultReplyTo || "the workspace address"}`}>Reply to</button>}
              </AddressRow>
              {/* Hidden, not removed, until asked for: a value typed in stays when the row is folded away again. */}
              <AddressRow label="Bcc" className={showBcc ? "" : "hidden"}>
                <input name="bcc" type="text" className={ADDRESS_INPUT} defaultValue={replying?.bcc ?? ""} autoComplete="off" spellCheck={false} />
              </AddressRow>
              <AddressRow label="Reply to" className={showReplyTo ? "" : "hidden"}>
                <input
                  name="replyTo"
                  className={ADDRESS_INPUT}
                  defaultValue={replying?.replyTo ?? defaultReplyTo}
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
            <p className="px-6 pb-6 text-xs text-slate-400 sm:px-10">
              Your signature{banners.length > 0 ? " and banner are" : " is"} added here when it is sent — Preview shows exactly what goes.{" "}
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
                  <button className="btn-primary" disabled={pending} onClick={sendNow}>
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
          {scheduleOpen && (
            <div className="rounded-lg border border-white/10 bg-black/20 p-3" data-testid="schedule-send">
              <p className="text-sm font-semibold text-white">Send later</p>
              <p className="mt-0.5 text-xs text-slate-400">
                It goes at the time you choose — on the hour or half hour — as you, after the same checks Send makes. Until then it waits on this customer&apos;s record, where it can be edited or cancelled.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {quickSendTimes(new Date()).map((option) => (
                  <button key={option.label} type="button" className="btn-secondary btn-sm" onClick={() => setLaterAt(localInputValue(option.at))}>
                    {option.label}
                  </button>
                ))}
                <input
                  type="datetime-local"
                  step={1800}
                  aria-label="Send at"
                  className="input h-8 w-auto py-0 text-sm"
                  value={laterAt}
                  onChange={(e) => setLaterAt(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={!laterAt || pending || checking}
                  onClick={() => {
                    // A time between runs goes at the next one: say so by showing it, rather than surprising anyone.
                    const at = nextHalfHour(new Date(laterAt));
                    setLaterAt(localInputValue(at));
                    schedulingRef.current = true;
                    // In the field before the form is submitted — not after the next render.
                    flushSync(() => {
                      setSendAt(at.toISOString());
                      setScheduling(true);
                    });
                    formRef.current?.requestSubmit();
                  }}
                >
                  <Clock className="size-4" />Schedule send
                </button>
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
                <button type="button" className="btn-primary btn-sm" onClick={() => submitNow(true)} disabled={pending}>{scheduling ? "Schedule anyway" : "Send anyway"}</button>
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
            {savedAt && !state?.ok && <span className="ml-auto text-xs text-slate-500">Draft saved {savedAt}</span>}
            {state?.ok ? (
              <button type="button" onClick={closeComposer} className="btn-secondary btn-sm ml-auto">Close</button>
            ) : confirmDiscard ? (
              <button
                type="button"
                className={`btn-secondary btn-sm text-red-300 ${savedAt ? "" : "ml-auto"}`}
                onClick={() => {
                  // Thrown away: the draft too, so it is not offered again.
                  if (saveTimer.current) clearTimeout(saveTimer.current);
                  saveTimer.current = null;
                  if (draftIdRef.current) void discardEmailDraft(draftIdRef.current).then(() => setWaitingKey((key) => key + 1));
                  adoptDraft(null);
                  setSubject("");
                  setBody("");
                  setAttached([]);
                  setAttachedQuotes([]);
                  setUploadFiles([]);
                  setConfirmDiscard(false);
                  setOpen(false);
                }}
              >
                Discard it — sure?
              </button>
            ) : (
              <button type="button" onClick={() => setConfirmDiscard(true)} className={`btn-secondary btn-sm ${savedAt ? "" : "ml-auto"}`}>
                Discard
              </button>
            )}
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
