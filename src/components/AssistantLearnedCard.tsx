"use client";

import Link from "next/link";
import { Check, Trash2 } from "lucide-react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { approveAssistantNote, deleteAssistantNote } from "@/app/actions/assistantNotes";
import { learnedLine, type LearnedItem } from "@/lib/assistantLearnedReviewRules";

/**
 * Under an answer that taught DAX something: WHAT it learned, in one line each, and — for the owner — Keep or Drop right
 * there (Sean, 2026-11-20: it used to say only "learned something", with no link, and the list was buried in Settings).
 * The same owner-only actions as Settings → Assistant, so the server decides who may.
 */
export default function AssistantLearnedCard({ name, notes, canReview }: { name: string; notes: LearnedItem[]; canReview: boolean }) {
  if (!notes.length) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-2.5 text-xs">
      <p className="font-medium">🧠 {name} learned from this</p>
      <ul className="space-y-1.5">
        {notes.map((note) => (
          <li key={note.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-muted-foreground">{learnedLine(note)}</span>
            {canReview && (
              <span className="flex items-center gap-1.5">
                <SaveForm action={approveAssistantNote.bind(null, note.id)} resetOnSuccess={false}>
                  <SaveButton className="btn-secondary btn-sm inline-flex items-center gap-1" title="Everyone's DAX uses it from now on.">
                    <Check className="size-3.5" /> Keep
                  </SaveButton>
                </SaveForm>
                <ConfirmActionDialog
                  trigger={
                    <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1 text-destructive">
                      <Trash2 className="size-3.5" /> Drop
                    </button>
                  }
                  title="Drop this?"
                  description={`${name} will stop using it straight away.`}
                  confirmLabel="Drop"
                  destructive
                  onConfirm={deleteAssistantNote.bind(null, note.id)}
                />
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        {canReview ? (
          <>Until you keep it, only the person it came from gets it. All of it is in <Link href="/settings/assistant" className="underline">Settings → Assistant</Link>.</>
        ) : (
          "The workspace owner reviews it; until then only your conversations use it."
        )}
      </p>
    </div>
  );
}
