"use client";

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowLeft, Camera, ExternalLink, Loader2, MessageSquare, Phone, Search, StickyNote, X } from "lucide-react";
import { addCommunication } from "@/app/actions/communications";
import { scheduleFollowUp } from "@/app/actions/activities";
import { loadCaptureRecord, searchCaptureRecords } from "@/app/actions/capture";
import { ACTION_NOT_DELIVERED } from "@/components/actionError";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  captureTargetFromPath,
  NEXT_STEP_KINDS,
  NEXT_STEP_WHEN,
  nextStepDue,
  waMeLink,
  type CaptureRecord,
  type NextStepKind,
  type NextStepWhen,
} from "@/lib/captureTarget";
import { MIN_SEARCH_TERM } from "@/lib/recordSearch";
import { cn } from "@/lib/utils";

type Mode = "call" | "whatsapp" | "note" | "photo";

const MODES: Array<{ key: Mode; label: string; detail: string; icon: typeof Phone; tone: string }> = [
  { key: "call", label: "Log a call", detail: "A call that already happened", icon: Phone, tone: "bg-sky-400/10 text-sky-300" },
  { key: "whatsapp", label: "WhatsApp", detail: "Open the chat, log it here", icon: MessageSquare, tone: "bg-emerald-400/10 text-emerald-300" },
  { key: "note", label: "Note", detail: "Internal, for your team", icon: StickyNote, tone: "bg-amber-400/10 text-amber-300" },
  { key: "photo", label: "Photo", detail: "From the camera, onto the record", icon: Camera, tone: "bg-violet-400/10 text-violet-300" },
];

/**
 * THE PHONE'S CAPTURE SHEET. A rep in the yard records what just happened —
 * a call, a WhatsApp, a note, a photo — without scrolling a record's page to its
 * composer (1,100px down on a phone, below four cards of context). The record is
 * the page they are on when it is a lead or customer; anywhere else they pick one
 * at the top. Each save ends on one "Next step" strip that schedules the follow-up
 * or is skipped.
 *
 * Writes are the record pages' own actions — addCommunication and scheduleFollowUp
 * check permission and record access themselves; the buttons here are gated on
 * the same keys those pages use (`can`), so nobody is offered a write that ends in
 * a refusal. `children` is what the sheet offered before this: the on-site links
 * and quick-create records.
 */
export default function CaptureSheet({ open, onOpenChange, pathname, can, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pathname: string;
  /** `record`: contacts.edit or leads.edit (CUSTOMER_RECORD_WRITE_PERMISSIONS). `schedule`: activities.manage. */
  can: { record: boolean; schedule: boolean };
  children?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Radix's dialog traps focus, closes on Escape and on the backdrop. The slide-in is skipped for
          anyone who asked for less motion. The bottom padding clears the home indicator. */}
      <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto rounded-t-2xl border-border bg-background p-0 pb-[max(.75rem,env(safe-area-inset-bottom))] motion-reduce:animate-none motion-reduce:transition-none lg:hidden">
        {/* The content unmounts with the sheet, so every open starts clean: the page's record, no mode, nothing saved. */}
        <CaptureBody pathname={pathname} can={can} onClose={() => onOpenChange(false)}>{children}</CaptureBody>
      </SheetContent>
    </Sheet>
  );
}

function CaptureBody({ pathname, can, onClose, children }: {
  pathname: string; can: { record: boolean; schedule: boolean }; onClose: () => void; children?: ReactNode;
}) {
  const [fromPage] = useState(() => captureTargetFromPath(pathname));
  const [target, setTarget] = useState<CaptureRecord | null>(null);
  // Looking up the page's record from the moment the sheet opens; nothing to look up elsewhere.
  const [loadingTarget, setLoadingTarget] = useState(Boolean(fromPage));
  const [mode, setMode] = useState<Mode | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!fromPage) return;
    let live = true;
    loadCaptureRecord(fromPage)
      .then((record) => { if (live) setTarget(record); })
      .catch(() => { if (live) setTarget(null); })
      .finally(() => { if (live) setLoadingTarget(false); });
    return () => { live = false; };
  }, [fromPage]);

  // addCommunication and scheduleFollowUp revalidate the page themselves, so the timeline behind the sheet is current.
  const finish = onClose;

  return (
    <>
        <SheetHeader className="border-b border-border px-4 pb-3 pt-4 text-left">
          <div className="flex items-center gap-2">
            {mode && !saved && (
              <button type="button" onClick={() => setMode(null)} className="-ml-1 grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label="Back to capture choices">
                <ArrowLeft className="size-4" />
              </button>
            )}
            <SheetTitle>{saved ? "Saved — next step?" : mode ? MODES.find((m) => m.key === mode)?.label : "Capture"}</SheetTitle>
          </div>
          <SheetDescription>
            {saved ? "Schedule the follow-up now, or skip it." : can.record ? "Record what just happened, on the record it belongs to." : "Start a record now. Complete the detail on desktop when needed."}
          </SheetDescription>
        </SheetHeader>

        <div className="grid gap-3 p-3">
          {can.record && !saved && (
            <TargetPicker target={target} loading={loadingTarget} fixed={Boolean(fromPage && target)} onChange={(record) => { setTarget(record); }} />
          )}

          {can.record && !saved && !mode && (
            <div className="grid grid-cols-2 gap-2">
              {MODES.map(({ key, label, detail, icon: Icon, tone }) => (
                <button
                  key={key}
                  type="button"
                  disabled={!target}
                  onClick={() => setMode(key)}
                  className="flex min-h-24 flex-col items-start justify-between gap-2 rounded-xl border border-border bg-card p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                >
                  <span className={cn("grid size-9 place-items-center rounded-lg", tone)}><Icon className="size-4" aria-hidden="true" /></span>
                  <span><span className="block text-sm font-semibold">{label}</span><span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span></span>
                </button>
              ))}
              {!target && !loadingTarget && <p className="col-span-2 px-1 text-xs text-muted-foreground">Choose who this is about first.</p>}
            </div>
          )}

          {can.record && !saved && mode && target && (
            <CaptureForm mode={mode} target={target} revalidate={pathname} onSaved={() => setSaved(true)} />
          )}

          {saved && target && (
            <NextStepStrip target={target} canSchedule={can.schedule} onDone={finish} />
          )}

          {!mode && !saved && children && (
            <div className="grid gap-2 border-t border-border pt-3">
              {children}
            </div>
          )}
        </div>
    </>
  );
}

/** Who this is about: the page's record when there is one, else a search over leads and customers. */
function TargetPicker({ target, loading, fixed, onChange }: {
  target: CaptureRecord | null; loading: boolean; fixed: boolean; onChange: (record: CaptureRecord | null) => void;
}) {
  const [term, setTerm] = useState("");
  const [found, setFound] = useState<CaptureRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const latest = useRef("");
  const timer = useRef<number | null>(null);
  const listId = useId();

  // A pending search is dropped with the picker — a result for a sheet that closed has nowhere to go.
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const search = (value: string) => {
    setTerm(value);
    const query = value.trim();
    latest.current = query;
    if (timer.current) window.clearTimeout(timer.current);
    if (query.length < MIN_SEARCH_TERM) { setFound([]); setSearching(false); return; }
    setSearching(true);
    timer.current = window.setTimeout(() => {
      searchCaptureRecords(query)
        .then((rows) => { if (latest.current === query) setFound(rows); })
        .catch(() => { if (latest.current === query) setFound([]); })
        .finally(() => { if (latest.current === query) setSearching(false); });
    }, 250);
  };

  if (loading) {
    return <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />Finding this record…</p>;
  }
  if (target) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{target.label}</p>
          <p className="truncate text-xs text-muted-foreground">{target.type === "lead" ? "Lead" : "Customer"}{target.sublabel ? ` · ${target.sublabel}` : ""}</p>
        </div>
        {!fixed && (
          <button type="button" onClick={() => { onChange(null); search(""); }} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" aria-label="Choose a different record">
            <X className="size-4" />
          </button>
        )}
      </div>
    );
  }
  return (
    <div>
      <label htmlFor={`${listId}-term`} className="sr-only">Who is this about?</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          id={`${listId}-term`}
          type="search"
          autoComplete="off"
          enterKeyHint="search"
          className="input pl-9"
          placeholder="Who is this about? Name, company or phone"
          value={term}
          onChange={(event) => search(event.target.value)}
          aria-controls={`${listId}-results`}
        />
      </div>
      <ul id={`${listId}-results`} className="mt-2 grid gap-1" aria-live="polite">
        {searching && <li className="px-1 text-xs text-muted-foreground">Searching…</li>}
        {!searching && term.trim().length >= MIN_SEARCH_TERM && found.length === 0 && <li className="px-1 text-xs text-muted-foreground">No lead or customer matches.</li>}
        {found.map((record) => (
          <li key={`${record.type}-${record.id}`}>
            <button type="button" onClick={() => onChange(record)} className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span className="shrink-0 rounded-md bg-muted px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{record.type === "lead" ? "Lead" : "Customer"}</span>
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{record.label}</span>{record.sublabel && <span className="block truncate text-xs text-muted-foreground">{record.sublabel}</span>}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One form per kind, all filed through addCommunication — the record pages'
 * own action, which checks the write permission and access to the record.
 * Submission is owned here rather than by SaveForm so a WhatsApp with nothing
 * typed still logs ("Sent a WhatsApp message"), and so the photo's file rides
 * the same FormData as its caption.
 */
function CaptureForm({ mode, target, revalidate, onSaved }: { mode: Mode; target: CaptureRecord; revalidate: string; onSaved: () => void }) {
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const chat = waMeLink(target.phone);

  const submit = (form: HTMLFormElement) => {
    const data = new FormData(form);
    if (target.leadId) data.set("leadId", target.leadId);
    if (target.contactId) data.set("contactId", target.contactId);
    data.set("revalidate", revalidate);
    const body = String(data.get("body") ?? "").trim();
    if (mode === "whatsapp") {
      data.set("type", "whatsapp");
      data.set("direction", "outbound");
      if (!body) data.set("body", "Sent a WhatsApp message");
    } else if (mode === "call") {
      data.set("type", "call");
      data.set("direction", "outbound");
      if (!body) { toast.error("Say what was discussed."); return; }
    } else {
      // A photo is a note with an image; the action refuses one with neither.
      data.set("type", "note");
      data.set("direction", "");
      if (mode === "note" && !body) { toast.error("Write the note first."); return; }
      if (mode === "photo" && !(fileRef.current?.files?.length)) { toast.error("Take or choose a photo first."); return; }
    }
    start(async () => {
      try {
        const result = await addCommunication(data);
        if (result?.error) { toast.error(String(result.error)); return; }
        toast.success(String(result?.success ?? "Logged"));
        onSaved();
      } catch {
        toast.error(ACTION_NOT_DELIVERED);
      }
    });
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => { event.preventDefault(); if (!pending) submit(event.currentTarget); }}
    >
      {mode === "whatsapp" && (
        chat ? (
          <a
            href={chat}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary justify-center"
          >
            <ExternalLink className="size-4" aria-hidden="true" />Open WhatsApp · {target.phone}
          </a>
        ) : (
          <p className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">No phone number on this record. The chat can still be logged.</p>
        )
      )}

      {mode === "photo" && (
        <div className="grid gap-2">
          {/* `capture` asks a phone for its camera straight away; a desktop browser ignores it and offers files. */}
          <input ref={fileRef} id={`${id}-photo`} type="file" name="image" accept="image/*" capture="environment" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; setPreview(file ? URL.createObjectURL(file) : null); }} />
          <label htmlFor={`${id}-photo`} className="btn-secondary min-h-12 cursor-pointer justify-center focus-within:ring-2 focus-within:ring-primary">
            <Camera className="size-4" aria-hidden="true" />{preview ? "Retake" : "Take photo"}
          </label>
          {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimisable asset */}
          {preview && <img src={preview} alt="The photo to attach" className="max-h-40 w-full rounded-lg border border-border object-cover" />}
        </div>
      )}

      <div>
        <label htmlFor={`${id}-body`} className="label">
          {mode === "call" ? "Outcome" : mode === "whatsapp" ? "What you said (optional)" : mode === "note" ? "Internal note · visible to your team" : "Caption (optional)"}
        </label>
        <textarea
          id={`${id}-body`}
          name="body"
          rows={3}
          autoFocus={mode !== "photo"}
          className="input"
          placeholder={mode === "call" ? "What was discussed, what was agreed" : mode === "whatsapp" ? "Optional — a line about the message" : mode === "note" ? "What should your team know?" : "What the photo shows"}
        />
      </div>

      {/* The sheet scrolls; the button stays at its foot so the keyboard never covers it. */}
      <div className="sticky bottom-0 -mx-3 border-t border-border bg-background px-3 pt-3">
        <button type="submit" disabled={pending} className="btn-primary min-h-12 w-full justify-center">
          {pending ? <><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Saving…</> : mode === "call" ? "Log call" : mode === "whatsapp" ? "Log WhatsApp" : mode === "note" ? "Save note" : "Save photo"}
        </button>
      </div>
    </form>
  );
}

/** One line: what kind of follow-up, and when. Schedules through scheduleFollowUp (activities.manage) or is skipped. */
function NextStepStrip({ target, canSchedule, onDone }: { target: CaptureRecord; canSchedule: boolean; onDone: () => void }) {
  const [kind, setKind] = useState<NextStepKind>("call");
  const [when, setWhen] = useState<NextStepWhen | null>(null);
  const [pending, start] = useTransition();
  const chip = (selected: boolean) => cn(
    "min-h-10 rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
    selected ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground",
  );
  const schedule = () => {
    if (!when) return;
    start(async () => {
      try {
        const result = await scheduleFollowUp({ leadId: target.leadId, contactId: target.contactId, type: kind, when: nextStepDue(when, new Date()) });
        if (!result.ok) { toast.error(result.error ?? "Could not schedule the next step."); return; }
        toast.success("Next step scheduled");
        onDone();
      } catch {
        toast.error(ACTION_NOT_DELIVERED);
      }
    });
  };
  if (!canSchedule) {
    return <button type="button" onClick={onDone} className="btn-primary min-h-12 w-full justify-center">Done</button>;
  }
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Next step">
        {NEXT_STEP_KINDS.map((option) => (
          <button key={option.key} type="button" aria-pressed={kind === option.key} onClick={() => setKind(option.key)} className={chip(kind === option.key)}>{option.label}</button>
        ))}
        <span className="self-center text-xs text-muted-foreground" aria-hidden="true">·</span>
        {NEXT_STEP_WHEN.map((option) => (
          <button key={option.key} type="button" aria-pressed={when === option.key} onClick={() => setWhen(option.key)} className={chip(when === option.key)}>{option.label}</button>
        ))}
      </div>
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <button type="button" onClick={onDone} disabled={pending} className="btn-secondary min-h-12 justify-center">Skip</button>
        <button type="button" onClick={schedule} disabled={pending || !when} className="btn-primary min-h-12 justify-center">
          {pending ? <><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />Scheduling…</> : "Schedule"}
        </button>
      </div>
    </div>
  );
}
