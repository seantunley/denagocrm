/** The note a Done saves on the timeline ("Activity done: …"), without its workspace (passed on its own). */
export type DoneNote = { type: string; direction: string; subject: string; body: string; leadId: string | null; contactId: string | null; userId: string };

/** Only what a Done touches — so the workspace-scoped client's transaction and the base one both fit. */
type DoneTx = {
  activity: { updateMany(args: { where: { id: string; status: string }; data: { status: string; doneAt: Date } }): PromiseLike<{ count: number }> };
  communication: { create(args: { data: DoneNote & { tenantId: string | null } }): PromiseLike<unknown> };
};

/**
 * PLANNED → DONE, AND ITS NOTE, AS ONE (review of #1152). The CRM's Done (finishActivity) used to mark the activity
 * done, then write the note separately: a note that failed left it done with no record of what happened, and its
 * card could not be retried. Two Confirms at once both passed the planned check and both wrote a note.
 *
 * Run inside ONE transaction: the move is conditional on the row still being planned, and only the caller that made
 * it (count 1) writes the note. A second caller gets false and writes nothing; a failed note rolls the move back.
 */
export async function completePlannedActivity(
  tx: DoneTx,
  input: { id: string; now: Date; tenantId: string | null; note: DoneNote | null },
): Promise<boolean> {
  const moved = await tx.activity.updateMany({ where: { id: input.id, status: "planned" }, data: { status: "done", doneAt: input.now } });
  if (moved.count !== 1) return false;
  if (input.note) await tx.communication.create({ data: { ...input.note, tenantId: input.tenantId } });
  return true;
}
