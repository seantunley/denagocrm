import { Check, Trash2 } from "lucide-react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import {
  approveAssistantNote,
  createAssistantNote,
  deleteAssistantNote,
  resolveAssistantConflict,
  updateAssistantNote,
} from "@/app/actions/assistantNotes";
import { formatDate, formatDateTime } from "@/lib/format";
import { FLAG_PREFIX } from "@/lib/assistantMemory";

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
  source: string;
  lastConfirmedAt: Date | null;
  lastUsedAt: Date | null;
  validUntil: Date | null;
  expired: boolean;
  /** For a held conflict: the approved text it contradicts (null if that entry has since gone). */
  conflictsWith: string | null;
};

/** Where it came from, and when. */
function origin(note: LearnedNote): string {
  const when = formatDateTime(note.createdAt);
  if (note.source === "owner") return `Taught by ${note.taughtBy ?? "the owner"} ${when}`;
  if (note.source === "person") return `Written by ${note.taughtBy ?? "them"} about themselves ${when}`;
  if (note.source === "tidy") return `Written by the nightly tidy-up ${when}`;
  return `Learned ${when}${note.taughtBy ? ` talking with ${note.taughtBy}` : ""}`;
}

const BADGE = {
  approved: { label: "Approved", tone: "bg-emerald-500/15 text-emerald-300" },
  conflict: { label: "Conflict", tone: "bg-red-500/15 text-red-300" },
  unreviewed: { label: "Unreviewed", tone: "bg-amber-500/15 text-amber-300" },
};
const badge = "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide";

const GROUPS: { kind: string; title: string; hint: string }[] = [
  { kind: "memory", title: "About the business", hint: "Facts it uses in every conversation." },
  { kind: "playbook", title: "Playbooks", hint: "Definitions and procedures it has learned — loaded when a question needs them." },
  { kind: "profile", title: "About your team", hint: "Each person's preferences — used only in their own conversations." },
];

/**
 * The owner's review list. The assistant learns on its own; an entry shows
 * "unreviewed" and is used only with the person it was learned from until it is
 * approved, edited or removed here (it came from THEIR conversation, with their
 * visibility). Approving shares it with everyone. Approved entries are the
 * owner's — the assistant can't rewrite or remove them.
 */
export default function AssistantLearnedReview({ notes }: { notes: LearnedNote[] }) {
  const unreviewed = notes.filter((n) => n.status !== "approved").length;
  const conflicts = notes.filter((n) => n.status === "conflict").length;
  return (
    <section className="max-w-3xl space-y-4">
      <div>
        <h2 className="text-base font-semibold">What it has learned</h2>
        <p className="text-sm text-muted-foreground">
          {notes.length === 0
            ? "Nothing yet — it learns as your team uses it, especially from corrections."
            : unreviewed
              ? `${unreviewed} new thing${unreviewed === 1 ? "" : "s"} to review. Until you approve one, it's used only in the conversations of the person it came from — approving shares it with everyone.`
              : "All reviewed."}
          {conflicts > 0 &&
            ` ${conflicts} contradict${conflicts === 1 ? "s" : ""} something you approved — it keeps to what you approved until you choose (shown first below).`}
        </p>
      </div>
      {GROUPS.map((group) => {
        // Conflicts first: they're the ones waiting on a decision.
        const items = notes.filter((n) => n.kind === group.kind).sort((a, b) => Number(b.status === "conflict") - Number(a.status === "conflict"));
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
                      {note.kind !== "playbook" && note.description?.startsWith(FLAG_PREFIX) && (
                        <p className="mt-1 text-xs text-amber-300">
                          Flagged in the nightly tidy-up: {note.description.slice(FLAG_PREFIX.length)} — approve it if it&apos;s right, or edit it.
                        </p>
                      )}
                      {note.status === "conflict" && (
                        <p className="mt-1 text-xs text-red-300">
                          {note.conflictsWith !== null
                            ? `Conflicts with what you approved: “${note.conflictsWith}”`
                            : "It conflicted with an entry that has since been removed."}{" "}
                          Not used by anyone until you choose.
                        </p>
                      )}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {note.about ? `About ${note.about} · ` : ""}
                        {origin(note)}
                        {note.lastConfirmedAt ? ` · Last confirmed ${formatDateTime(note.lastConfirmedAt)}` : ""}
                        {note.lastUsedAt ? ` · Last used ${formatDateTime(note.lastUsedAt)}` : ""}
                        {note.validUntil ? ` · ${note.expired ? "Ended" : "Until"} ${formatDate(note.validUntil)}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className={`${badge} ${(BADGE[note.status as keyof typeof BADGE] ?? BADGE.unreviewed).tone}`}>
                        {(BADGE[note.status as keyof typeof BADGE] ?? BADGE.unreviewed).label}
                      </span>
                      {note.expired && (
                        <span className={`${badge} bg-muted text-muted-foreground`} title="Past its last day — not used. Edit to extend it, or remove it.">
                          Expired
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {note.status === "conflict" && (
                      <>
                        <SaveForm action={resolveAssistantConflict.bind(null, note.id, "new")} resetOnSuccess={false}>
                          <SaveButton className="btn-secondary btn-sm inline-flex items-center gap-1" title="Approve this one; the entry it contradicts is removed.">
                            <Check className="size-3.5" /> Keep new
                          </SaveButton>
                        </SaveForm>
                        <SaveForm action={resolveAssistantConflict.bind(null, note.id, "existing")} resetOnSuccess={false}>
                          <SaveButton className="btn-secondary btn-sm" title="Keep what you approved; this one is removed.">
                            Keep existing
                          </SaveButton>
                        </SaveForm>
                      </>
                    )}
                    {note.status !== "approved" && note.status !== "conflict" && (
                      <SaveForm action={approveAssistantNote.bind(null, note.id)} resetOnSuccess={false}>
                        <SaveButton className="btn-secondary btn-sm inline-flex items-center gap-1">
                          <Check className="size-3.5" /> Approve
                        </SaveButton>
                      </SaveForm>
                    )}
                    <details className="w-full text-xs sm:w-auto">
                      <summary className="btn-secondary btn-sm cursor-pointer list-none">Edit</summary>
                      <SaveForm action={updateAssistantNote.bind(null, note.id)} resetOnSuccess={false} className="mt-2 space-y-2">
                        {note.kind === "playbook" && (
                          <div className="grid gap-2 sm:grid-cols-2">
                            <input name="name" defaultValue={note.name ?? ""} maxLength={48} className="input" aria-label="Playbook name" />
                            <input name="description" defaultValue={note.description ?? ""} maxLength={60} className="input" aria-label="Description" />
                          </div>
                        )}
                        <textarea name="content" defaultValue={note.content} rows={note.kind === "playbook" ? 8 : 2} className="input w-full" />
                        <label className="flex flex-wrap items-center gap-2 text-muted-foreground">
                          Use until
                          <input
                            type="date"
                            name="validUntil"
                            defaultValue={note.validUntil ? note.validUntil.toISOString().slice(0, 10) : ""}
                            className="input w-auto"
                          />
                          <span className="text-[11px]">Empty = for good. After this day it stops using it, and it shows here as expired.</span>
                        </label>
                        <SaveButton className="btn-primary btn-sm">Save</SaveButton>
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
      <TeachIt />
    </section>
  );
}

/** The owner teaches it directly — approved from the start. */
function TeachIt() {
  return (
    <div className="card grid gap-4 p-4 lg:grid-cols-2">
      <SaveForm action={createAssistantNote} className="space-y-2">
        <input type="hidden" name="kind" value="memory" />
        <h3 className="text-sm font-semibold">Teach it a business fact</h3>
        <p className="text-xs text-muted-foreground">Something true in every conversation — who handles what, a policy, how you do things.</p>
        <textarea name="content" rows={2} maxLength={400} className="input w-full" placeholder="e.g. Donovan handles all fleet and golf-estate deals." />
        <SaveButton className="btn-secondary btn-sm">Add fact</SaveButton>
      </SaveForm>
      <SaveForm action={createAssistantNote} className="space-y-2">
        <input type="hidden" name="kind" value="playbook" />
        <h3 className="text-sm font-semibold">Teach it a playbook</h3>
        <p className="text-xs text-muted-foreground">A definition or a way of doing something, loaded whenever a question needs it.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input name="name" maxLength={48} className="input" placeholder="Name, e.g. hot-lead" />
          <input name="description" maxLength={60} className="input" placeholder="One line (60 characters)" />
        </div>
        <textarea name="content" rows={4} maxLength={1500} className="input w-full" placeholder={"e.g. A hot lead is in Quoted or later, worth over R150k,\nand has heard from us in the last 14 days."} />
        <SaveButton className="btn-secondary btn-sm">Add playbook</SaveButton>
      </SaveForm>
    </div>
  );
}
