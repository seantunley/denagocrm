import { cancelActivity, completeActivity, rescheduleActivity } from "@/app/actions/activities";
import type { ActionCard } from "./assistantActions";

type ActivityCard = Extract<ActionCard, { kind: "reschedule" | "cancel_activity" | "complete_activity" }>;

/**
 * Confirm a card about a PLANNED activity — move it, cancel it, or mark it done — through the CRM's own doors
 * (access, the not-before-its-day rule for a done, the audit entry). The caller has already checked the activity
 * still reads as the card showed it (stillAsProposed).
 */
export async function runActivityCard(card: ActivityCard): Promise<{ error?: string; success: string }> {
  if (card.kind === "reschedule") {
    const result = await rescheduleActivity(card.activityId, card.when);
    return { ...(result.ok ? {} : { error: result.error ?? "Couldn't move it." }), success: "Moved" };
  }
  if (card.kind === "cancel_activity") {
    const result = await cancelActivity(card.activityId, "/assistant");
    return { ...(result.error ? { error: result.error } : {}), success: "Cancelled" };
  }
  // Done WITH what happened (Sean, 2026-11-17: "There must be context put in the done") — saved on the timeline.
  if (!String(card.note ?? "").trim()) return { error: "There's no note of what happened — ask again.", success: "" };
  const form = new FormData();
  form.set("note", card.note);
  form.set("revalidate", "/assistant");
  const result = await completeActivity(card.activityId, form);
  return { ...(result.error ? { error: result.error } : {}), success: "Marked done, with your note on the timeline" };
}
