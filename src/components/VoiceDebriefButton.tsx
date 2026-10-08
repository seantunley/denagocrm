"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { draftVoiceDebrief } from "@/app/actions/voice";
import { logVoiceDebrief } from "@/app/actions/activities";
import type { DebriefDraft } from "@/lib/voiceDebrief";
import { audioForm, useVoiceRecorder } from "@/components/useVoiceRecorder";

/**
 * "Log by voice" on a lead: talk through the call or visit, check the draft,
 * save. Nothing is saved until Save — the draft is ChatGPT's reading of what
 * was said, and the person is the one who knows whether it's right.
 */
export default function VoiceDebriefButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<(DebriefDraft & { type: "call" | "meeting" }) | null>(null);
  const [summarised, setSummarised] = useState(true);
  const [saving, startSaving] = useTransition();

  const voice = useVoiceRecorder(async (audio) => {
    setDrafting(true);
    setError(null);
    const result = await draftVoiceDebrief(audioForm(audio, { leadId })).catch(() => ({
      ok: false as const,
      error: "Couldn't send the recording.",
    }));
    setDrafting(false);
    if (!result.ok) return setError(result.error);
    setSummarised(result.summarised);
    setDraft({ ...result.draft, type: "call" });
  });

  const save = () => {
    if (!draft) return;
    const notes = [
      draft.notes,
      draft.nextStep && `Next step: ${draft.nextStep}`,
      `What was said:\n${draft.transcript}`,
    ].filter(Boolean).join("\n\n");
    startSaving(async () => {
      const result = await logVoiceDebrief({
        leadId,
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

  if (!voice.supported) return null;

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
            ChatGPT isn&apos;t connected, so this is the plain transcript — add a summary yourself.
          </p>
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
            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={voice.recording ? voice.stop : voice.start}
        disabled={drafting}
        className={`btn-secondary btn-sm inline-flex items-center gap-1.5 ${voice.recording ? "border-destructive text-destructive" : ""}`}
      >
        {drafting ? (
          <><Loader2 className="size-4 animate-spin" /> Writing it up…</>
        ) : voice.recording ? (
          <><Square className="size-3.5" /> Stop ({voice.seconds}s)</>
        ) : (
          <><Mic className="size-4" /> Log a call or visit by voice</>
        )}
      </button>
      {(error || voice.error) && <p className="text-xs text-destructive">{error ?? voice.error}</p>}
    </div>
  );
}
