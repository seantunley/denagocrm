"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Editor } from "@tiptap/react";
import { Clock, FileText, Paperclip, Receipt, Send, X, Eye, LayoutTemplate, ChevronDown, Mail } from "lucide-react";
import { checkComposerEmail, composerBannerChoices, composerIdentity, discardEmailDraft, openEmailDraft, previewComposerEmail, saveEmailDraft, sendEmailAction, type SendEmailState } from "@/app/actions/emails";
import { SECURE_LINK_DAYS, SECURE_LINK_DEFAULT_DAYS } from "@/lib/secureLinks";
import { secureLinkHint } from "@/lib/sendCheck";
import { parseAddressList, parseReplyTo } from "@/lib/replyToAddresses";
import { EMAIL_UPLOAD_MAX_BYTES, EMAIL_UPLOAD_MAX_FILES, emailUploads } from "@/lib/emailUploads";
import { dealChoice, NO_DEAL, postedDealId, type DealOption } from "@/lib/customerTimeline";
import type { ComposerQuote } from "@/lib/composerQuotes";
import { COMPOSE_REPLY_EVENT, replyDraft, type ComposeReplyDetail } from "@/lib/emailReply";
import { localInputValue, nextHalfHour, quickSendTimes } from "@/lib/emailSchedule";
import { formatDateTime } from "@/lib/format";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import AiCheckButton from "@/components/AiCheckButton";
import EmailRecipients from "@/components/EmailRecipients";
import EmailWaitingList from "@/components/EmailWaitingList";
import RichTextEditor from "@/components/RichTextEditor";
import EmailRibbon from "@/components/EmailRibbon";

const TOOL = "inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";
const LABEL = "w-16 shrink-0 text-sm text-muted-foreground";
const fileSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function textToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}
export type RenderedTemplate = { id: string; name: string; subject: string; body: string };
type EmailComposerDraft = {
  to: string; cc: string; bcc: string; replyTo: string;
  subject: string; body: string; banner: string; dealId: string;
  attached: string[]; attachedQuotes: string[]; uploads: File[];
  secure: boolean; days: number;
  /** The timeline email this answers (Reply / Reply all): the server checks it and threads the reply to it. */
  inReplyTo: string;
};

export default function EmailComposer({ defaultTo, templates, smtpConfigured, leadId, contactId, revalidate,
  libraryDocs = [], deals = [], quotes = [], aiConfigured = false, defaultReplyTo = "", compactTrigger = false,
}: {
  defaultTo: string; templates: RenderedTemplate[]; smtpConfigured: boolean; leadId?: string; contactId?: string; revalidate: string;
  libraryDocs?: { id: string; label: string; fileName: string; sizeBytes?: number }[];
  deals?: readonly DealOption[]; quotes?: ComposerQuote[]; aiConfigured?: boolean; defaultReplyTo?: string; compactTrigger?: boolean;
}) {
  const router = useRouter();
  const choice = dealChoice(deals);
  const freshDraft = (): EmailComposerDraft => ({ to: defaultTo, cc: "", bcc: "", replyTo: defaultReplyTo, subject: "", body: "", banner: "",
    dealId: leadId ?? (choice.ask ? "" : choice.leadId ?? ""), attached: [], attachedQuotes: [], uploads: [], secure: false, days: SECURE_LINK_DEFAULT_DAYS, inReplyTo: "" });
  const [draft, setDraft] = useState<EmailComposerDraft>(freshDraft);
  const { to, cc, bcc, replyTo, subject, body, banner, dealId, attached, attachedQuotes, uploads, secure, days, inReplyTo } = draft;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [identity, setIdentity] = useState<{ from: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<SendEmailState | undefined>();
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const busy = pending || checking;
  const sending = useRef(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [imageProblem, setImageProblem] = useState("");
  const [banners, setBanners] = useState<{ id: string; name: string }[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [showReplyTo, setShowReplyTo] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  // setEditable normally emits an update; that must not erase a send result or dirty a sent draft.
  useEffect(() => { editor?.setEditable(!busy, false); }, [editor, busy]);
  const formRef = useRef<HTMLFormElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  // DRAFTS ARE KEPT ON THE SERVER (lib/emailDrafts.ts, #890), never on the device (review of #893: a browser copy
  // outlived sign-out for a week, unencrypted). What is written is saved a moment after each change; closing the
  // window keeps it; it waits on this record to be continued. Files from the computer are not kept with a draft.
  const draftIdRef = useRef<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState("");
  const [unsaved, setUnsaved] = useState(false);
  const [waitingKey, setWaitingKey] = useState(0);
  const adoptDraft = (id: string | null) => { draftIdRef.current = id; setDraftId(id); setSavedAt(""); };
  function update(patch: Partial<EmailComposerDraft>) {
    if (sending.current) return;
    setDraft((previous) => ({ ...previous, ...patch }));
    setDirty(true); setUnsaved(true); setState(undefined); setWarning(null);
  }
  const setBody = (html: string) => update({ body: html });
  const pickedQuotes = quotes.filter((q) => attachedQuotes.includes(q.id));
  const allFiles = [
    ...attached.map((key) => ({ name: libraryDocs.find((d) => d.id === key)?.fileName ?? "Document", sizeBytes: libraryDocs.find((d) => d.id === key)?.sizeBytes ?? 0 })),
    ...uploads.map((file) => ({ name: file.name, sizeBytes: file.size })),
    ...pickedQuotes.map((q) => ({ name: q.fileName, sizeBytes: 0 })),
  ];
  const linkHint = secureLinkHint(allFiles.map((f) => f.name), secure);

  /** Open the window — on what was being written, or on `start` (a reply, a draft continued). */
  async function openComposer(start?: EmailComposerDraft) {
    if (loading) return;
    setLoading(true); setPreviewError(""); setWarning(null); setImageProblem("");
    try {
      const nextIdentity = await composerIdentity(contactId, leadId);
      const availableBanners = await composerBannerChoices().catch(() => []);
      setBanners(availableBanners); setIdentity(nextIdentity);
      // What was written before closing the window is still here (the component is keyed by the record).
      const base = start ?? (dirty ? draft : freshDraft());
      const next = { ...base, banner: base.banner === "none" || availableBanners.some((b) => b.id === base.banner) ? base.banner : "" };
      setDraft(next);
      if (start) setDirty(true);
      setShowCc(Boolean(next.cc)); setShowBcc(Boolean(next.bcc)); setShowReplyTo(next.replyTo !== defaultReplyTo);
      setState(undefined); setOpen(true);
    } catch { setPreviewError("Could not load the sender or customer context. Refresh the page and try again."); }
    finally { setLoading(false); }
  }

  // REPLY / REPLY ALL / FORWARD from an email on the timeline (EmailReplyButtons, #889): the composer opens with the
  // addresses filled, the email quoted and — for a reply — the email it answers. Reply all's Cc is the one stored
  // with that email (Communication.cc), never read out of its words.
  const openRef = useRef(openComposer);
  useEffect(() => { openRef.current = openComposer; });
  useEffect(() => {
    const onReply = (event: Event) => {
      const { email, kind } = (event as CustomEvent<ComposeReplyDetail>).detail;
      const reply = replyDraft(email, kind, { customer: defaultTo, when: formatDateTime(email.occurredAt) });
      adoptDraft(null);
      void openRef.current({ ...freshDraft(), to: kind === "forward" ? "" : defaultTo, cc: reply.cc, subject: reply.subject, body: reply.html, inReplyTo: kind === "forward" ? "" : email.id });
    };
    window.addEventListener(COMPOSE_REPLY_EVENT, onReply);
    return () => window.removeEventListener(COMPOSE_REPLY_EVENT, onReply);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- freshDraft reads only props
  }, [defaultTo]);

  /** Continue a draft from the waiting list — or take back a scheduled send to edit it. A problem to show, if any. */
  async function openDraft(id: string): Promise<string | undefined> {
    const opened = await openEmailDraft(id);
    if (!opened.draft) return opened.error ?? "That draft could not be opened.";
    const d = opened.draft;
    adoptDraft(d.id);
    await openComposer({
      to: d.to, cc: d.cc, bcc: d.bcc, replyTo: d.replyTo, subject: d.subject, body: d.bodyHtml, banner: d.banner,
      dealId: leadId ?? d.leadId ?? (choice.ask ? "" : choice.leadId ?? ""),
      attached: d.attachIds.filter((key) => libraryDocs.some((doc) => doc.id === key)),
      attachedQuotes: d.quoteIds.filter((key) => quotes.some((q) => q.id === key)),
      uploads: [], secure: d.secureLinks, days: d.secureDays ?? SECURE_LINK_DEFAULT_DAYS, inReplyTo: d.inReplyToId ?? "",
    });
    setUnsaved(false);
    if (opened.filesDropped?.length) setImageProblem(`Files from your computer are not kept with a draft — attach again: ${opened.filesDropped.join(", ")}.`);
    return undefined;
  }

  // AUTOSAVE a moment after the last change. Nothing is kept for an empty email, or once it has gone.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const written = useRef(draft);
  useEffect(() => { written.current = draft; });
  async function saveDraftNow() {
    const now = written.current;
    if (sending.current) return;
    if (!now.subject.trim() && !now.body.replace(/<[^>]+>/g, "").trim()) return;
    const saved = await saveEmailDraft(draftIdRef.current, {
      to: now.to, cc: now.cc, bcc: now.bcc, replyTo: now.replyTo, subject: now.subject, bodyHtml: now.body,
      contactId: contactId ?? null, leadId: now.dealId || leadId || null,
      attachIds: now.attached, quoteIds: now.attachedQuotes, banner: now.banner,
      secureLinks: now.secure, secureDays: now.days, inReplyToId: now.inReplyTo || null,
    }).catch(() => null);
    if (saved?.id) {
      if (saved.id !== draftIdRef.current) setWaitingKey((key) => key + 1);
      draftIdRef.current = saved.id; setDraftId(saved.id);
      setSavedAt(formatDateTime(new Date()));
      if (written.current === now) setUnsaved(false);
    }
  }
  useEffect(() => {
    if (!open || !dirty || state?.ok) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void saveDraftNow(); }, 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saves on a change to what is written
  }, [draft]);
  const cancelSave = () => { if (saveTimer.current) clearTimeout(saveTimer.current); saveTimer.current = null; };

  // Only what is not yet saved — or a file from the computer, which a draft does not keep — is lost by leaving.
  useEffect(() => {
    if (!dirty || state?.ok || (!unsaved && uploads.length === 0)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, unsaved, uploads.length, state?.ok]);

  /** Close the window, keeping what is written: a save still waiting is made now. */
  function closeComposer() {
    if (sending.current) return;
    if (saveTimer.current) { cancelSave(); void saveDraftNow(); }
    setOpen(false);
  }
  function setUploadFiles(picked: File[]) {
    const seen = new Set<string>();
    const files = picked.filter((f) => { const key = `${f.name}:${f.size}:${f.lastModified}`; if (seen.has(key)) return false; seen.add(key); return true; });
    const checked = emailUploads({ getAll: () => files });
    if ("error" in checked) { setImageProblem(checked.error); return; }
    update({ uploads: files });
  }

  // SEND LATER (#890): at the time chosen, on the hour or half hour, as the sender, after the same checks.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [laterAt, setLaterAt] = useState("");
  // The time a warning was raised for, so "Schedule anyway" schedules — never sends now.
  const [warnedSendAt, setWarnedSendAt] = useState<Date | null>(null);

  /** Send now — or, with `sendAt`, schedule it. The time is put in what is posted here, in code, never in a field. */
  async function submit(confirmed = false, sendAt: Date | null = null) {
    if (sending.current || !formRef.current?.reportValidity()) return;
    setState(undefined); setPreviewError("");
    for (const [label, raw] of [["To", to], ["Cc", cc], ["Bcc", bcc]]) {
      const parsed = parseAddressList(raw, 10);
      if (!parsed.ok || (label === "To" && !parsed.value)) { setState({ error: `Check ${label}: ${parsed.ok ? "add a recipient" : parsed.invalid.join(", ")}.` }); return; }
    }
    const replies = parseReplyTo(replyTo);
    if (!replies.ok) { setState({ error: `Check Reply-to: ${replies.invalid.join(", ")}.` }); return; }
    if (!subject.trim() || editor?.isEmpty !== false) { setState({ error: "Add a subject and message before sending." }); return; }
    // Going now (or being scheduled): no autosave may follow and keep a draft of an email that has gone.
    cancelSave();
    // Snapshot before disabling controls. Files are controlled, so failures never clear the upload input's only copy.
    const data = new FormData(formRef.current);
    uploads.forEach((file) => data.append("upload", file));
    data.set("sensitiveOk", confirmed ? "1" : "");
    data.set("draftId", draftIdRef.current ?? "");
    if (sendAt) data.set("sendAt", sendAt.toISOString()); else data.delete("sendAt");
    sending.current = true; setChecking(true);
    try {
      const check = await checkComposerEmail({ to, cc, bcc, subject, bodyHtml: body, contactId, leadId: postedDealId(dealId) ?? leadId, fileNames: allFiles.map((f) => f.name), secureLinks: secure && allFiles.length > 0 });
      if (check.error) { setPreview(null); setState({ error: check.error }); return; }
      if (check.warning && !confirmed) { setPreview(null); setWarnedSendAt(sendAt); setWarning(check.warning); return; }
      setWarning(null); setChecking(false); setPending(true);
      const result = await sendEmailAction(undefined, data);
      setState(result); setPreview(null);
      if (result.ok) {
        // Sent or scheduled: the draft is done with, and the composer is ready for the next email.
        adoptDraft(null);
        setDirty(false); setUnsaved(false); setDraft(freshDraft()); setScheduleOpen(false); setLaterAt("");
        setWaitingKey((key) => key + 1);
        router.refresh();
      }
    } catch {
      setPreview(null);
      setState({ error: "Could not confirm the result. Your draft is intact. Check the customer history before retrying to avoid sending twice." });
    } finally { sending.current = false; setPending(false); setChecking(false); }
  }

  const [preview, setPreview] = useState<{ html: string; to: string; cc: string; bcc: string; replyTo: string; sentState: typeof state } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  async function showPreview() {
    const field = (name: string) => String(new FormData(formRef.current ?? undefined).get(name) ?? "").trim();
    setPreviewing(true); setPreviewError("");
    try {
      const { html } = await previewComposerEmail(
        body,
        { to: field("to"), contactId, leadId, choice: field("banner") },
        secure && allFiles.length > 0 ? { files: allFiles, days } : undefined,
      );
      setPreview({ html, to: field("to"), cc: field("cc"), bcc: field("bcc"), replyTo: field("replyTo"), sentState: state });
    } catch { setPreviewError("Couldn't build the preview — try again."); }
    finally { setPreviewing(false); }
  }
  // YOUR SIGNATURE under the message while you write (#888): built by the server exactly as Send adds it (Preview's
  // builder, with no message), again when the recipient or banner changes — a customer who opted out gets no banner.
  const [signature, setSignature] = useState<{ html: string; key: string } | null>(null);
  const signatureKey = `${to}:${banner}`;
  useEffect(() => {
    if (!open || !smtpConfigured) return;
    let alive = true;
    const timer = setTimeout(() => {
      void previewComposerEmail("", { to, contactId, leadId, choice: banner }).then(({ html }) => { if (alive) setSignature({ html, key: signatureKey }); }, () => { if (alive) setSignature(null); });
    }, 500);
    return () => { alive = false; clearTimeout(timer); };
  }, [open, smtpConfigured, to, banner, contactId, leadId, signatureKey]);

  const [attachOpen, setAttachOpen] = useState(false);
  const [attachFilter, setAttachFilter] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateFilter, setTemplateFilter] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const template = templates.find((t) => t.id === selectedTemplate);
  const filteredTemplates = templates.filter((t) => `${t.name} ${t.subject}`.toLowerCase().includes(templateFilter.toLowerCase()));
  const [confirmTemplate, setConfirmTemplate] = useState(false);
  function applyTemplate() {
    if (!template) return;
    update({ subject: template.subject, body: textToHtml(template.body) });
    setConfirmTemplate(false); setTemplateOpen(false);
  }
  const [discardOpen, setDiscardOpen] = useState(false);
  function discard() {
    // Thrown away: the saved draft too, so it is not offered again.
    cancelSave();
    if (draftIdRef.current) void discardEmailDraft(draftIdRef.current).then(() => setWaitingKey((key) => key + 1));
    adoptDraft(null);
    setDraft(freshDraft()); setDirty(false); setUnsaved(false); setState(undefined); setDiscardOpen(false); setOpen(false);
  }
  const [attachmentPreview, setAttachmentPreview] = useState<{ name: string; src: string; image?: boolean; local?: boolean } | null>(null);
  useEffect(() => () => { if (attachmentPreview?.local) URL.revokeObjectURL(attachmentPreview.src); }, [attachmentPreview]);
  function previewUpload(file: File) {
    const safeImage = /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type);
    if (!safeImage && file.type !== "application/pdf") { setImageProblem("Preview is available for PDF files and images. Other file types can still be attached."); return; }
    setAttachmentPreview({ name: file.name, src: URL.createObjectURL(file), image: safeImage, local: true });
  }

  return <>
    <button type="button" onClick={() => void openComposer()} disabled={loading} className={compactTrigger ? TOOL : "card flex w-full items-center justify-between text-left font-semibold hover:border-primary/60"}>
      <span className="inline-flex items-center gap-2"><Mail className="size-4" />{loading ? "Opening…" : compactTrigger ? "Email" : "Send email"}</span>
      {!compactTrigger && <span className="text-xs font-normal text-muted-foreground">Compose a message</span>}
    </button>
    {!open && previewError && <p role="alert" className="mt-2 text-sm text-red-300">{previewError}</p>}
    <EmailWaitingList contactId={contactId} leadId={leadId} revalidate={revalidate} refreshKey={waitingKey} onOpen={openDraft} />
    <Dialog open={open} onOpenChange={(next) => { if (!next) closeComposer(); }}>
      {/* A window in front of the page, as Outlook's is (Sean, 2026-10-18: "it looks weird when this window is open"):
          the default 50% backdrop barely dims this dark app, and a border-coloured edge vanished into it. */}
      <DialogContent showCloseButton={false} overlayClassName="bg-black/75 backdrop-blur-[2px]" className="top-0 translate-y-0 sm:top-1/2 sm:-translate-y-1/2 flex h-[100dvh] max-h-[100dvh] w-full max-w-full flex-col gap-0 overflow-hidden rounded-none border-white/15 bg-card p-0 shadow-2xl shadow-black/70 sm:h-[94dvh] sm:max-w-[min(1400px,96vw)] sm:rounded-xl" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onPointerDownOutside={(event) => event.preventDefault()}>
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0"><DialogTitle className="truncate text-base">{subject.trim() || "New email"}</DialogTitle><DialogDescription className="sr-only">Compose an email. Closing this window keeps what you have written as a draft on this record.</DialogDescription></div>
          <button type="button" onClick={() => closeComposer()} disabled={busy} aria-label="Close" title="Close — what you have written is kept as a draft" className={TOOL}><X className="size-4" /></button>
        </div>
        {!smtpConfigured ? <p className="p-6 text-sm text-muted-foreground">Email sending isn&apos;t configured. <Link href="/settings?tab=email" className="text-primary underline">Open email settings</Link></p> : (
          <form ref={formRef} onSubmit={(event) => { event.preventDefault(); void submit(); }} className="flex min-h-0 flex-1 flex-col">
            {contactId && <input type="hidden" name="contactId" value={contactId} />}
            <input type="hidden" name="revalidate" value={revalidate} />
            <input type="hidden" name="banner" value={banner} />
            <input type="hidden" name="bodyHtml" value={body} />
            <input type="hidden" name="inReplyTo" value={inReplyTo} />
            <input type="hidden" name="draftId" value={draftId ?? ""} />
            <fieldset disabled={busy} className="m-0 flex min-h-0 flex-1 flex-col border-0 p-0">
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                <div className="space-y-2.5 px-4 py-3 sm:px-6">
                  <div className="flex items-baseline gap-3 text-xs"><span className="w-16 shrink-0 text-muted-foreground">From</span><span className="break-all">{identity?.from}</span></div>
                  <div className="flex items-start gap-3"><span className={`${LABEL} py-2.5`}>To</span><EmailRecipients label="To" name="to" value={to} onChange={(value) => update({ to: value })} required disabled={busy} /></div>
                  <div className="flex flex-wrap gap-3 pl-[76px] text-xs">
                    <button type="button" className="text-muted-foreground hover:text-primary" aria-expanded={showCc} onClick={() => setShowCc(!showCc)}>Cc{cc && !showCc ? " (set)" : ""}</button>
                    <button type="button" className="text-muted-foreground hover:text-primary" aria-expanded={showBcc} onClick={() => setShowBcc(!showBcc)}>Bcc{bcc && !showBcc ? " (set)" : ""}</button>
                    <button type="button" className="text-muted-foreground hover:text-primary" aria-expanded={showReplyTo} onClick={() => setShowReplyTo(!showReplyTo)}>Reply-to</button>
                  </div>
                  <div hidden={!showCc}><div className="flex items-start gap-3"><span className={`${LABEL} py-2.5`}>Cc</span><EmailRecipients label="Cc" name="cc" value={cc} onChange={(value) => update({ cc: value })} disabled={busy} /></div></div>
                  <div hidden={!showBcc}><div className="flex items-start gap-3"><span className={`${LABEL} py-2.5`}>Bcc</span><EmailRecipients label="Bcc" name="bcc" value={bcc} onChange={(value) => update({ bcc: value })} disabled={busy} /></div></div>
                  <div hidden={!showReplyTo}><label className="flex items-center gap-3"><span className={LABEL}>Reply-to</span><input name="replyTo" type="text" className="input min-w-0 flex-1" value={replyTo} onChange={(event) => update({ replyTo: event.target.value })} placeholder="you@example.com, crm@example.com" /></label><p className="mt-1 pl-[76px] text-xs text-muted-foreground">Include the CRM mailbox to keep replies on the record.</p></div>
                  <label className="flex items-center gap-3"><span className={LABEL}>Subject</span><input name="subject" className="input min-w-0 flex-1 font-medium" required value={subject} onChange={(event) => update({ subject: event.target.value })} placeholder="Add a subject" /></label>
                  {leadId || !choice.ask ? <input type="hidden" name="leadId" value={dealId} /> : <label className="flex items-center gap-3"><span className="w-16 shrink-0 text-xs text-muted-foreground">Regarding</span><select name="leadId" required className="input min-w-0 flex-1" value={dealId} onChange={(event) => update({ dealId: event.target.value })}><option value="" disabled>Choose the deal this email is about…</option>{deals.map((deal) => <option key={deal.id} value={deal.id}>{deal.label}</option>)}<option value={NO_DEAL}>The customer in general</option></select></label>}
                  {!choice.ask && deals.length === 1 && <p className="pl-[76px] text-xs text-muted-foreground">Regarding: {deals[0].label}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-1 border-t border-border px-3 py-1.5">
                  <button type="button" onClick={() => setTemplateOpen(true)} disabled={!templates.length} className={TOOL}><LayoutTemplate className="size-4" />Use template<ChevronDown className="size-3" /></button>
                  <button type="button" onClick={() => setAttachOpen(true)} disabled={!libraryDocs.length && !quotes.length} className={TOOL}><FileText className="size-4" />Library & quotes</button>
                  {banners.length > 0 && <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">Banner<select className="max-w-44 rounded-md border border-border bg-card px-2 py-1.5 text-foreground" value={banner} onChange={(event) => update({ banner: event.target.value })}><option value="">{banners[0].name} (default)</option>{banners.slice(1).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}<option value="none">No banner</option></select></label>}
                </div>
                <EmailRibbon key={editor ? "ready" : "waiting"} editor={editor} onImageProblem={setImageProblem} insert={<button type="button" onClick={() => uploadRef.current?.click()} className={TOOL} title={`Up to ${EMAIL_UPLOAD_MAX_FILES} files, ${EMAIL_UPLOAD_MAX_BYTES / 1024 / 1024} MB total`}><Paperclip className="size-4" />Attach file</button>} />
                <input ref={uploadRef} type="file" multiple className="hidden" aria-label="Choose email attachments" onChange={(event) => { setUploadFiles([...uploads, ...Array.from(event.target.files ?? [])]); event.target.value = ""; }} />
                {allFiles.length > 0 && <div className="space-y-3 border-b border-border px-5 py-3">
                  <div className="flex flex-wrap gap-2">
                    {attached.map((key) => { const doc = libraryDocs.find((d) => d.id === key); return <span key={key} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs"><button type="button" className="min-w-0 break-all text-left hover:text-primary" onClick={() => setAttachmentPreview({ name: doc?.fileName ?? "Document", src: `/api/library/${key}` })}>{doc?.fileName ?? "Document"}{doc?.sizeBytes ? ` · ${fileSize(doc.sizeBytes)}` : ""}</button><button type="button" aria-label={`Remove ${doc?.fileName ?? "document"}`} onClick={() => update({ attached: attached.filter((value) => value !== key) })}><X className="size-3.5" /></button><input type="hidden" name="attach" value={key} /></span>; })}
                    {uploads.map((file, index) => <span key={`${file.name}-${index}`} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs"><button type="button" className="min-w-0 break-all text-left hover:text-primary" onClick={() => previewUpload(file)}>{file.name} <span className="text-muted-foreground">· {fileSize(file.size)}</span></button><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setUploadFiles(uploads.filter((_, i) => i !== index))}><X className="size-3.5" /></button></span>)}
                    {pickedQuotes.map((q) => <span key={q.id} data-testid="attached-quote" className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs"><button type="button" className="min-w-0 break-all text-left hover:text-primary" onClick={() => setAttachmentPreview({ name: `${q.label} · ${q.fileName}`, src: `/quotes/${q.id}/print` })}>{q.label} · {q.fileName}</button><button type="button" aria-label={`Remove ${q.fileName}`} onClick={() => update({ attachedQuotes: attachedQuotes.filter((key) => key !== q.id) })}><X className="size-3.5" /></button><input type="hidden" name="attachQuote" value={q.id} /></span>)}
                  </div>
                  {pickedQuotes.some((q) => q.draft) && <p data-testid="quote-will-be-sent" className="text-xs text-amber-300">{pickedQuotes.filter((q) => q.draft).map((q) => q.label).join(", ")} will be marked sent when this email goes. Later changes require a revision.</p>}
                  <details><summary className="cursor-pointer text-xs text-muted-foreground">File delivery: {secure ? "secure links" : "attachments"}</summary><div className="mt-2 space-y-2 text-xs"><label className="flex items-center gap-2"><input type="checkbox" name="secureLinks" checked={secure} onChange={(event) => update({ secure: event.target.checked })} />Send files as expiring, recallable secure links</label>{secure && <label className="flex items-center gap-2">Link works for<select name="secureDays" className="input !w-auto py-1 text-xs" value={days} onChange={(event) => update({ days: Number(event.target.value) })}>{SECURE_LINK_DAYS.map((d) => <option key={d} value={d}>{d} {d === 1 ? "day" : "days"}</option>)}</select></label>}</div></details>
                  {linkHint && <p className="text-xs text-amber-300">{linkHint}</p>}
                </div>}
                <div className="flex-1 cursor-text bg-[#e9ebee] px-2 py-4 sm:px-6 sm:py-5" onMouseDown={(event) => { if (editor && event.target === event.currentTarget) { event.preventDefault(); editor.chain().focus("end").run(); } }}>
                  <div className="mx-auto max-w-[820px] overflow-hidden rounded-sm bg-white shadow-sm" style={{ fontFamily: "Arial, Helvetica, sans-serif" }}>
                    <RichTextEditor
                      value={body}
                      onChange={setBody}
                      emailTools
                      appearance="page"
                      showToolbar={false}
                      pasteImages
                      onImageProblem={setImageProblem}
                      onEditorReady={setEditor}
                      placeholder="Write your message…"
                    />
                    <div className="border-t border-slate-100 px-5 py-3 sm:px-10"><p className="mb-2 text-[11px] text-slate-500">Signature & banner · added automatically</p>{signature?.key === signatureKey ? <iframe title="Signature preview" sandbox="" srcDoc={signature.html} className="h-40 w-full border-0 bg-white" /> : <p className="text-xs text-slate-500">Use Preview to check the signature and banner before sending.</p>}</div>
                  </div>
                </div>
              </div>
            </fieldset>
            <div className="shrink-0 space-y-2 border-t border-border bg-card px-4 py-3 sm:px-5">
              {scheduleOpen && <div className="rounded-lg border border-border bg-muted/30 p-3" data-testid="schedule-send">
                <p className="text-sm font-semibold">Send later</p>
                <p className="mt-0.5 text-xs text-muted-foreground">It goes at the time you choose — on the hour or half hour — as you, after the same checks Send makes. Until then it waits on this customer&apos;s record, where it can be edited or cancelled.</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {quickSendTimes(new Date()).map((option) => <button key={option.label} type="button" className="btn-secondary btn-sm" onClick={() => setLaterAt(localInputValue(option.at))}>{option.label}</button>)}
                  <input type="datetime-local" step={1800} aria-label="Send at" className="input h-8 w-auto py-0 text-sm" value={laterAt} onChange={(event) => setLaterAt(event.target.value)} />
                  <button type="button" className="btn-primary btn-sm gap-1.5" disabled={!laterAt || busy} onClick={() => {
                    // A time between runs goes at the next one: say so by showing it, rather than surprising anyone.
                    const at = nextHalfHour(new Date(laterAt));
                    setLaterAt(localInputValue(at));
                    void submit(false, at);
                  }}><Clock className="size-4" />Schedule send</button>
                </div>
              </div>}
              {warning && <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><p className="font-semibold text-amber-200">Check before you send</p><p className="mt-1 text-amber-100">{warning}</p><div className="mt-3 flex gap-2"><button type="button" className="btn-secondary btn-sm" onClick={() => setWarning(null)}>Back to editing</button><button type="button" className="btn-primary btn-sm" onClick={() => void submit(true, warnedSendAt)} disabled={busy}>{warnedSendAt ? "Schedule anyway" : "Send anyway"}</button></div></div>}
              {state?.error && <p role="alert" className="text-sm text-red-300">{state.error}</p>}
              {state?.ok && <p role="status" className="text-sm text-emerald-400">{state.ok}</p>}
              {previewError && <p role="alert" className="text-xs text-red-300">{previewError}</p>}
              {imageProblem && <p role="alert" className="text-xs text-amber-300">{imageProblem} <button type="button" className="underline" onClick={() => setImageProblem("")}>Dismiss</button></p>}
              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" className="btn-primary gap-2" disabled={busy || Boolean(state?.ok)}><Send className="size-4" />{pending ? "Sending…" : checking ? "Checking…" : "Send email"}</button>
                <button type="button" onClick={() => setScheduleOpen((shown) => !shown)} aria-expanded={scheduleOpen} className="btn-secondary gap-1.5" disabled={busy || Boolean(state?.ok)} title="Send it later, at a time you choose"><Clock className="size-4" />Send later</button>
                <button type="button" onClick={() => void showPreview()} className="btn-secondary gap-1.5" disabled={previewing || busy}><Eye className="size-4" />{previewing ? "Preparing…" : "Preview"}</button>
                <AiCheckButton getDraft={() => editor?.getText() ?? ""} contactId={contactId} leadId={leadId} configured={aiConfigured} label="Check wording" />
                {savedAt && !state?.ok && <span role="status" className="ml-auto text-xs text-muted-foreground">Draft saved {savedAt}</span>}
                <button type="button" disabled={busy} className={`${TOOL} ${savedAt && !state?.ok ? "" : "ml-auto"}`} onClick={() => dirty ? setDiscardOpen(true) : closeComposer()}>{state?.ok ? "Close" : "Discard"}</button>
              </div>
            </div>
          </form>
        )}
        <Dialog open={attachOpen} onOpenChange={setAttachOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
          <DialogTitle>Attach library documents & quotes</DialogTitle><DialogDescription>Choose files to include. Quotes are generated as PDFs when sent.</DialogDescription>
          <input aria-label="Search attachments" className="input" placeholder="Search documents or quote numbers…" value={attachFilter} onChange={(event) => setAttachFilter(event.target.value)} />
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {quotes.filter((q) => `${q.label} ${q.fileName}`.toLowerCase().includes(attachFilter.toLowerCase())).map((q) => <button key={q.id} type="button" aria-pressed={attachedQuotes.includes(q.id)} onClick={() => update({ attachedQuotes: attachedQuotes.includes(q.id) ? attachedQuotes.filter((key) => key !== q.id) : [...attachedQuotes, q.id] })} className={`flex w-full items-center gap-2 rounded-lg border p-3 text-left text-sm ${attachedQuotes.includes(q.id) ? "border-primary bg-primary/10" : "border-border"}`}><Receipt className="size-4" />Quote {q.label}<span className="ml-auto text-xs text-muted-foreground">{attachedQuotes.includes(q.id) ? "Attached" : "Add PDF"}</span></button>)}
            {libraryDocs.filter((d) => `${d.label} ${d.fileName}`.toLowerCase().includes(attachFilter.toLowerCase())).map((d) => <button key={d.id} type="button" aria-pressed={attached.includes(d.id)} onClick={() => update({ attached: attached.includes(d.id) ? attached.filter((key) => key !== d.id) : [...attached, d.id] })} className={`flex w-full items-center gap-2 rounded-lg border p-3 text-left text-sm ${attached.includes(d.id) ? "border-primary bg-primary/10" : "border-border"}`}><FileText className="size-4" /><span className="min-w-0 break-all">{d.label}<span className="block text-xs text-muted-foreground">{d.fileName}{d.sizeBytes ? ` · ${fileSize(d.sizeBytes)}` : ""}</span></span><span className="ml-auto text-xs">{attached.includes(d.id) ? "Attached" : "Add"}</span></button>)}
          </div><button type="button" className="btn-primary justify-self-end" onClick={() => setAttachOpen(false)}>Done</button>
        </DialogContent></Dialog>
        <Dialog open={templateOpen} onOpenChange={(next) => { setTemplateOpen(next); setConfirmTemplate(false); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
          <DialogTitle>Choose an email template</DialogTitle><DialogDescription>Preview the wording before applying it to your message.</DialogDescription>
          <input aria-label="Search templates" className="input" placeholder="Search templates…" value={templateFilter} onChange={(event) => setTemplateFilter(event.target.value)} />
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]"><div className="max-h-64 space-y-1 overflow-y-auto">
            {filteredTemplates.map((t) => <button key={t.id} type="button" aria-pressed={selectedTemplate === t.id} onClick={() => { setSelectedTemplate(t.id); setConfirmTemplate(false); }} className={`w-full rounded-lg p-2.5 text-left text-sm ${selectedTemplate === t.id ? "bg-primary/10 text-primary" : "hover:bg-muted"}`}>{t.name}</button>)}
            {!filteredTemplates.length && <p className="p-2 text-sm text-muted-foreground">No templates match your search.</p>}
          </div><div className="min-h-48 rounded-lg border border-border p-4">{template ? <><p className="text-sm font-semibold">{template.subject}</p><p className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm text-muted-foreground">{template.body}</p></> : <p className="text-sm text-muted-foreground">Select a template to preview it.</p>}</div></div>
          {confirmTemplate && <p role="alert" className="text-sm text-amber-300">Applying this template will replace your current subject and message.</p>}
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setTemplateOpen(false)}>Cancel</button><button type="button" className="btn-primary" disabled={!template} onClick={() => { if ((subject.trim() || !editor?.isEmpty) && !confirmTemplate) setConfirmTemplate(true); else applyTemplate(); }}>{confirmTemplate ? "Replace subject & message" : "Use template"}</button></div>
        </DialogContent></Dialog>
        <Dialog open={Boolean(preview && preview.sentState === state)} onOpenChange={(next) => { if (!next) setPreview(null); }}><DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-4xl">
          <DialogTitle>Email preview</DialogTitle><DialogDescription>What the customer receives, including your signature and banner.</DialogDescription>
          {preview && <><dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"><dt>From</dt><dd className="break-all">{identity?.from}</dd><dt>To</dt><dd className="break-all">{preview.to}</dd>{preview.cc && <><dt>Cc</dt><dd className="break-all">{preview.cc}</dd></>}{preview.bcc && <><dt>Bcc (private)</dt><dd className="break-all">{preview.bcc}</dd></>}{preview.replyTo && <><dt>Reply-to</dt><dd className="break-all">{preview.replyTo}</dd></>}<dt>Subject</dt><dd>{subject}</dd>{allFiles.length > 0 && <><dt>{secure ? "Secure links" : "Attachments"}</dt><dd className="break-all">{allFiles.map((file) => file.name).join(", ")}</dd></>}</dl>
            <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[55dvh] w-full rounded-lg border border-border bg-white" />
            <div className="flex gap-2"><button type="button" className="btn-primary" disabled={busy || Boolean(state?.ok)} onClick={() => void submit()}>Send email</button><button type="button" className="btn-secondary" onClick={() => setPreview(null)}>Back to editing</button></div></>}
        </DialogContent></Dialog>
        <Dialog open={discardOpen} onOpenChange={setDiscardOpen}><DialogContent>
          <DialogTitle>Discard this email?</DialogTitle><DialogDescription>This deletes the message, its attachments and its saved draft. Use the close button to keep it as a draft instead.</DialogDescription>
          <div className="flex justify-end gap-2"><button type="button" disabled={busy} className="btn-secondary" onClick={() => setDiscardOpen(false)}>Keep editing</button><button type="button" disabled={busy} className="btn-danger" onClick={() => discard()}>Discard email</button></div>
        </DialogContent></Dialog>
        <Dialog open={Boolean(attachmentPreview)} onOpenChange={(next) => { if (!next) setAttachmentPreview(null); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
          <DialogTitle className="break-all">{attachmentPreview?.name}</DialogTitle><DialogDescription>Attachment preview. Close to return to your draft.</DialogDescription>
          {attachmentPreview && (attachmentPreview.image ?
            // eslint-disable-next-line @next/next/no-img-element
            <img src={attachmentPreview.src} alt={attachmentPreview.name} className="max-h-[65dvh] w-full object-contain" /> : <iframe title="Attachment preview" sandbox="allow-same-origin" src={attachmentPreview.src} className="h-[65dvh] w-full rounded-lg border border-border bg-white" />)}
          {attachmentPreview && <a href={attachmentPreview.src} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline">Open attachment in a new tab</a>}
        </DialogContent></Dialog>
      </DialogContent>
    </Dialog>
  </>;
}
