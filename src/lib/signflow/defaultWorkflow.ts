import "server-only";
import { getSetting } from "@/lib/settings";

/**
 * The workflow a quote is sent through unless the sender picks another.
 *
 * A workflow had to be chosen by hand on every send, so an approval rule only
 * held for as long as everyone remembered to choose it — which is not a rule.
 * The owner names one here (Settings → Signing workflows) and the send card
 * starts on it; "Built-in" is still one click away for the quote that needs it.
 *
 * One per workspace, in settings, rather than the per-layout column
 * DocBuilderTemplate.defaultWorkflowId: the send card would have to resolve the
 * quote's layout to read that, which is too slow to do every time the card opens.
 */
export const SIGNING_DEFAULT_WORKFLOW_KEY = "SIGNING_DEFAULT_WORKFLOW";

/** The saved default's id, or null. The caller checks it is still a workflow it can offer. */
export async function defaultSignWorkflowId(): Promise<string | null> {
  const value = (await getSetting(SIGNING_DEFAULT_WORKFLOW_KEY).catch(() => null))?.trim();
  return value || null;
}
