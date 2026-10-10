/**
 * The people a sender puts into the steps a workflow left open — as they arrive
 * from the browser, and how to say who is still missing.
 *
 * Pure, and free of any server binding: the send card and the action that
 * receives its answer both read these.
 */
import { z } from "zod";
import type { ChosenPerson, WorkflowAsk } from "./compile";

/** More steps than any real workflow asks about; a request naming more is not one of ours. */
const MAX_CHOICES = 40;

const person = z.union([
  z.object({ userId: z.string().min(1).max(64) }).strict(),
  z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(254) }).strict(),
]);
const choices = z.record(z.string().min(1).max(80), person);

/**
 * Who was chosen, by workflow node id. `{}` when nothing was sent; `null` when
 * what arrived is not a set of choices at all — which the caller refuses rather
 * than treating as "nobody chosen", so a malformed name or address is reported
 * instead of quietly becoming a missing step.
 */
export function parseChosen(input: unknown): Record<string, ChosenPerson> | null {
  if (input === undefined || input === null) return {};
  const parsed = choices.safeParse(input);
  if (!parsed.success || Object.keys(parsed.data).length > MAX_CHOICES) return null;
  return parsed.data;
}

/** "Finance approval and Second signer" — for the message saying who still has to be chosen. */
export function askList(asks: WorkflowAsk[]): string {
  const names = asks.map((ask) => ask.label);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
