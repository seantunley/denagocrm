import type { AttentionSignalKind } from "./score";

export const REPEAT_SNOOZE_THRESHOLD = 3;

export type AttentionDisposition = {
  kind: AttentionSignalKind;
  signalKey: string;
  state: "snoozed" | "dismissed";
  reason: string;
  snoozedUntil?: string;
  dismissedAt?: string;
  snoozeCount: number;
  lastSnoozedAt?: string;
};

export type AttentionDispositionMap = Record<string, AttentionDisposition>;

export function parseAttentionDispositions(value: unknown): AttentionDispositionMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AttentionDispositionMap = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Partial<AttentionDisposition>;
    if (row.signalKey !== key || (row.state !== "snoozed" && row.state !== "dismissed")) continue;
    if (typeof row.reason !== "string" || typeof row.kind !== "string") continue;
    const parsed = { ...row, snoozeCount: Math.max(0, Number(row.snoozeCount) || 0) } as AttentionDisposition;
    // A disposition with no readable date is not a disposition. Dropping it here
    // means the signal stays ON the list, which is the safe direction to fail in:
    // this screen exists so nothing is forgotten, and a row that cannot say when
    // it was set aside — or when it comes back — cannot justify hiding anything.
    if (!dispositionAt(parsed)) continue;
    out[key] = parsed;
  }
  return out;
}

/**
 * When this disposition happened: the instant it was dismissed, or the date the
 * snooze runs to.
 *
 * An accessor rather than `row.dismissedAt!` at the call site. Both timestamps
 * are optional on the type because the column is JSONB and can hold anything an
 * older build wrote, so asserting one away turns a malformed row into an
 * `Invalid Date` rendered at somebody. Returning null makes the caller decide,
 * and `parseAttentionDispositions` uses it to refuse such rows outright.
 */
export function dispositionAt(row: AttentionDisposition): Date | null {
  const raw = row.state === "dismissed" ? row.dismissedAt : row.snoozedUntil;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Is this disposition still hiding its signal?
 *
 * A type guard, not a boolean: it already answers "is there a row here", so the
 * caller narrowing on it should not then have to assert the row exists — which
 * is exactly the non-null assertion this replaced.
 *
 * An ELAPSED snooze is simply not active, so the signal returns on its own and
 * nothing has to sweep the column.
 */
export function dispositionIsActive(
  row: AttentionDisposition | undefined,
  now: Date,
): row is AttentionDisposition {
  if (!row) return false;
  if (row.state === "dismissed") return true;
  const until = dispositionAt(row);
  return until != null && until.getTime() > now.getTime();
}

