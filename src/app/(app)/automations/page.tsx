import { redirect } from "next/navigation";

/**
 * The AutomationRule builder has been retired — /journeys does everything it
 * did, and more (waits, branches, SMS, tags, versioning, run history).
 *
 * Three engines answered "when X happens to a lead, send an email / create an
 * activity / move a stage": AutomationRule, the Journey engine, and the
 * hardcoded lifecycleJourneys. The Journey engine is the one that survives; the
 * migration 20260802120000_retire_automation_rules converted every configured
 * rule into a Journey, so nothing built here was lost.
 *
 * Kept as a redirect rather than deleted, for the same reason as
 * /quotes/[id]: the URL is out in the world. It is in the Settings →
 * Automations tab, in the journeys breadcrumb, in the sidebar under Operations,
 * in the README, and in push notifications already delivered to someone's phone
 * (journeyStepExecutor's send_push falls back to /automations when a journey has
 * neither lead nor contact). Those could be repointed; bookmarks and delivered
 * notifications could not.
 *
 * No access check: a redirect grants nothing. /journeys enforces its own
 * (requireOwner), landing the caller where a guard here would have.
 */
export default async function AutomationsRedirect() {
  redirect("/journeys");
}
