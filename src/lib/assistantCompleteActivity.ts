/**
 * MARK A FOLLOW-UP DONE (Sean, 2026-11-17: "Follow up for Derek done. New status. Awaiting Ivan to revert" — DAX
 * saw the planned call, could only say it "needs closing separately", and had no way to close it).
 *
 * "There must be context put in the done" (Sean, same day): the card carries a NOTE of what happened, required, in
 * the person's words. Confirm runs the CRM's own Done button (completeActivity), which saves that note on the
 * timeline as "Activity done: …", refuses a day that has not started, and checks access.
 */
export const COMPLETE_ACTIVITY_RULE =
  "- complete_activity: when they say a PLANNED follow-up, call, meeting or to-do HAS BEEN DONE (\"follow up for Derek done\", \"I called Anna\"). " +
  "activityId is the planned activity's id from lead_brief or activities — the one that is due or overdue and matches what they did; if more than one could be meant, ask which. " +
  "\"note\" is REQUIRED: what happened and where it stands, in their words (\"Updated Derek. Awaiting Ivan to revert on the paperwork.\") — it is saved on the timeline with the done. Ask for it if they gave none; never invent one. " +
  "Only something due today or earlier: an activity on a later day cannot be marked done — offer reschedule instead. " +
  "When they say it is done, propose this rather than telling them to close it themselves. If they also give a next step, propose that as its own follow_up.";

/** What the card shows before Confirm, and the note Confirm saves. */
export const completeActivityText = (note: string) => `Note saved with it: ${note}`;
