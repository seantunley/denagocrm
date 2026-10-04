import { Check, Trash2 } from "lucide-react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { approveAssistantNote, deleteAssistantNote, updateAssistantNote } from "@/app/actions/assistantNotes";
import { formatDateTime } from "@/lib/format";

export type LearnedNote = {
  id: string;
  kind: string;
  name: string | null;
  description: string | null;
  content: string;
  status: string;
  createdAt: Date;
  about: string | null; // the person a profile entry describes
  taughtBy: string | null;
};

const GROUPS: { kind: string; title: string; hint: string }[] = [
  { kind: "memory", title: "About the business", hint: "Facts it uses in every conversation." },
  { kind: "playbook", title: "Playbooks", hint: "Definitions and procedures it has learned — loaded when a question needs them." },
  { kind: "profile", title: "About your team", hint: "Each person's preferences — used only in their own conversations." },
];

/**
 * The owner's review list. The assistant learns on its own; entries apply as
 * soon as they're learned and show "unreviewed" until approved, edited or
 * removed here. Approved entries are the owner's — the assistant can't rewrite
 * or remove them.
 */
export default function AssistantLearnedReview({ notes }: { notes: LearnedNote[] }) {
  const unreviewed = notes.filter((n) => n.status !== "approved").length;
  return (
    <section className="max-w-3xl space-y-4">
      <div>
        <h2 className="text-base font-semibold">What it has learned</h2>
        <p className="text-sm text-muted-foreground">
          {notes.length === 0
            ? "Nothing yet — it learns as your team uses it, especially from corrections."
            : unreviewed
              ? `${unreviewed} new thing${unreviewed === 1 ? "" : "s"} to review. They're already in use; approve, correct or remove them.`
              : "All reviewed."}
        </p>
      </div>
      {GROUPS.map((group) => {
        const items = notes.filter((n) => n.kind === group.kind);
        if (!items.length) return null;
        return (
          <div key={group.kind} className="card space-y-3 p-4">
            <div>
              <h3 className="text-sm font-semibold">{group.title}</h3>
              <p className="text-xs text-muted-foreground">{group.hint}</p>
            </div>
            <ul className="divide-y divide-border/50">
              {items.map((note) => (
                <li key={note.id} className="space-y-2 py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      {note.name && (
                        <p className="text-sm font-medium">
                          {note.name} <span className="font-normal text-muted-foreground">— {note.description}</span>
                        </p>
                      )}
                      <p className="whitespace-pre-line text-sm">{note.content}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {note.about ? `About ${note.about} · ` : ""}Learned {formatDateTime(note.createdAt)}
                        {note.taughtBy ? ` talking with ${note.taughtBy}` : ""}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${note.status === "approved" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}
                    >
                      {note.status === "approved" ? "Approved" : "Unreviewed"}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {note.status !== "approved" && (
                      <SaveForm action={approveAssistantNote.bind(null, note.id)} resetOnSuccess={false}>
                        <SaveButton className="btn-secondary btn-sm inline-flex items-center gap-1">
                          <Check className="size-3.5" /> Approve
                        </SaveButton>
                      </SaveForm>
                    )}
                    <details className="text-xs">
                      <summary className="btn-secondary btn-sm cursor-pointer list-none">Correct it</summary>
                      <SaveForm action={updateAssistantNote.bind(null, note.id)} resetOnSuccess={false} className="mt-2 space-y-2">
                        <textarea name="content" defaultValue={note.content} rows={note.kind === "playbook" ? 6 : 2} className="input w-full" />
                        <SaveButton className="btn-primary btn-sm">Save correction</SaveButton>
                      </SaveForm>
                    </details>
                    <ConfirmActionDialog
                      trigger={
                        <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1 text-destructive">
                          <Trash2 className="size-3.5" /> Remove
                        </button>
                      }
                      title="Remove this?"
                      description="The assistant will stop using it straight away."
                      confirmLabel="Remove"
                      destructive
                      onConfirm={deleteAssistantNote.bind(null, note.id)}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
