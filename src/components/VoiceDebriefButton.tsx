"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleDot, Keyboard, Loader2, Mic, Phone, Square } from "lucide-react";
import { toast } from "sonner";
import { draftTypedDebrief, draftVoiceDebrief } from "@/app/actions/voice";
import { logVoiceDebrief } from "@/app/actions/activities";
import type { DebriefDraft } from "@/lib/voiceDebrief";
import { CALL_RECORDING_SECONDS, MAX_RECORDING_SECONDS, audioForm, useVoiceRecorder } from "@/components/useVoiceRecorder";

/** "Customer only" in the which-deal choice. */
const CUSTOMER_ONLY = "";
type Mode = "talk" | "record" | "type";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * "Log a call" on a deal or a customer (Sean, 2026-11-14: "Record or dictate a call, and DAX writes the summary,
 * files it and proposes the follow-up"). Three ways in — talk it through afterwards, record the call itself, or type
 * notes — and one way out: a draft (summary, notes, next step, follow-up date) the person checks and edits, filed
 * only on Save. The audio is transcribed and dropped; nothing is kept.
 *
 * On a customer, the call goes on their one open deal; "which deal?" is asked only when there are several
 * (single-customer timeline). `openDeals` are deals this person may open.
 */
export default function VoiceDebriefButton({
  leadId,
  contactId,
  openDeals = [],
}: {
  leadId?: string;
  contactId?: string;
  openDeals?: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const [typed, setTyped] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<(DebriefDraft & { type: "call" | "meeting" }) | null>(null);
  const [summarised, setSummarised] = useState(true);
  const [deal, setDeal] = useState(openDeals.length === 1 ? openDeals[0].id : CUSTOMER_ONLY);
  const [saving, startSaving] = useTransition();
  const target: Record<string, string> = leadId ? { leadId } : { contactId: contactId ?? "" };

  const drafted = (result: Awaited<ReturnType<typeof draftVoiceDebrief>>) => {
    setDrafting(false);
    if (!result.ok) return setError(result.error);
    setSummarised(result.summarised);
    setDraft({ ...result.draft, type: "call" });
    setMode(null);
    setTyped("");
  };
  const failed = { ok: false as const, error: "Couldn't send it — check your connection and try again." };

  const voice = useVoiceRecorder(
    async (audio) => {
      setDrafting(true);
      setError(null);
      drafted(await draftVoiceDebrief(audioForm(audio, { ...target, ...(mode === "record" ? { call: "1" } : {}) })).catch(() => failed));
    },
    // A recorded call runs long, so it is kept small: speech at 32 kbps is clear enough to transcribe.
    mode === "record" ? { maxSeconds: CALL_RECORDING_SECONDS, bitsPerSecond: 32_000 } : { maxSeconds: MAX_RECORDING_SECONDS },
  );

  const writeTyped = async () => {
    setDrafting(true);
    setError(null);
    const form = new FormData();
    for (const [key, value] of Object.entries(target)) form.set(key, value);
    form.set("text", typed);
    drafted(await draftTypedDebrief(form).catch(() => failed));
  };

  const save = () => {
    if (!draft) return;
    const notes = [
      draft.notes,
      draft.nextStep && `Next step: ${draft.nextStep}`,
      `What was said:\n${draft.transcript}`,
    ].filter(Boolean).join("\n\n");
    const on = leadId ? { leadId } : deal ? { leadId: deal } : { contactId };
    startSaving(async () => {
      const result = await logVoiceDebrief({
        ...on,
        type: draft.type,
        summary: draft.summary,
        notes,
        followUpDate: draft.followUpDate || undefined,
        nextStep: draft.nextStep,
      });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't save it.");
        return;
      }
      toast.success(draft.followUpDate ? "Logged, and the follow-up is booked" : "Logged on the timeline");
      setDraft(null);
      router.refresh();
    });
  };

  if (draft) {
    const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft({ ...draft, [key]: value });
    return (
      <div className="card space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Check before saving</h3>
          <div className="flex gap-1 text-xs">
            {(["call", "meeting"] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => set("type", type)}
                className={`rounded-full border px-2.5 py-1 ${draft.type === type ? "border-primary text-foreground" : "border-border text-muted-foreground"}`}
              >
                {type === "call" ? "Call" : "Visit"}
              </button>
            ))}
          </div>
        </div>
        {!summarised && (
          <p className="text-xs text-muted-foreground">
            ChatGPT isn&apos;t connected, so this is the plain text — add a summary yourself.
          </p>
        )}
        {!leadId && openDeals.length > 1 && (
          <label className="block text-xs text-muted-foreground">
            Which deal was it about?
            <select className="input mt-1 w-full" value={deal} onChange={(e) => setDeal(e.target.value)}>
              <option value={CUSTOMER_ONLY}>None — just the customer</option>
              {openDeals.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </label>
        )}
        <label className="block text-xs text-muted-foreground">
          Summary
          <input className="input mt-1 w-full" value={draft.summary} maxLength={200} onChange={(e) => set("summary", e.target.value)} />
        </label>
        <label className="block text-xs text-muted-foreground">
          Notes
          <textarea className="input mt-1 min-h-24 w-full" value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-muted-foreground">
            Next step
            <input className="input mt-1 w-full" value={draft.nextStep} maxLength={200} onChange={(e) => set("nextStep", e.target.value)} />
          </label>
          <label className="block text-xs text-muted-foreground">
            Follow-up call on (optional)
            <input type="date" className="input mt-1 w-full" value={draft.followUpDate} onChange={(e) => set("followUpDate", e.target.value)} />
          </label>
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">What was said</summary>
          <p className="mt-1 whitespace-pre-line">{draft.transcript}</p>
        </details>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={() => setDraft(null)} disabled={saving}>
            Discard
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={save} disabled={saving || !draft.summary.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : draft.followUpDate ? "Save and book follow-up" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  if (drafting) {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Writing it up…
      </p>
    );
  }

  if (voice.recording) {
    return (
      <div className="space-y-1">
        <button type="button" onClick={voice.stop} className="btn-secondary btn-sm inline-flex items-center gap-1.5 border-destructive text-destructive">
          <Square className="size-3.5" /> Stop ({clock(voice.seconds)}{mode === "record" ? ` of ${clock(CALL_RECORDING_SECONDS)}` : ""})
        </button>
        {mode === "record" && <p className="text-xs text-muted-foreground">Recording — put the call on speaker.</p>}
      </div>
    );
  }

  if (mode === "type") {
    return (
      <div className="card space-y-2 p-3">
        <label className="block text-xs text-muted-foreground">
          What was said on the call
          <textarea
            className="input mt-1 min-h-28 w-full"
            value={typed}
            maxLength={20_000}
            autoFocus
            placeholder="He wants the XL in white, finance through the bank, asked us to call back Friday…"
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={() => { setMode(null); setError(null); }}>Cancel</button>
          <button type="button" className="btn-primary btn-sm" onClick={writeTyped} disabled={!typed.trim()}>Write it up</button>
        </div>
      </div>
    );
  }

  if (mode === "record") {
    return (
      <div className="card space-y-2 p-3">
        {/* POPIA: the other party must know. Said before the microphone opens, every time. */}
        <p className="text-xs">Tell the customer the call is being recorded before you start. The recording is turned into text and then deleted.</p>
        {(error || voice.error) && <p className="text-xs text-destructive">{error ?? voice.error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={() => { setMode(null); setError(null); }}>Cancel</button>
          <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={voice.start}>
            <CircleDot className="size-4" /> They know — start recording
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-sm font-medium"><Phone className="size-4" /> Log a call</span>
        {voice.supported && (
          <>
            <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => { setMode("talk"); setError(null); voice.start(); }}>
              <Mic className="size-4" /> Talk it through
            </button>
            <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => { setMode("record"); setError(null); }}>
              <CircleDot className="size-4" /> Record the call
            </button>
          </>
        )}
        <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => { setMode("type"); setError(null); }}>
          <Keyboard className="size-4" /> Type notes
        </button>
      </div>
      {(error || voice.error) && <p className="text-xs text-destructive">{error ?? voice.error}</p>}
    </div>
  );
}
