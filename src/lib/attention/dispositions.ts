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
    out[key] = { ...row, snoozeCount: Math.max(0, Number(row.snoozeCount) || 0) } as AttentionDisposition;
  }
  return out;
}

export function dispositionIsActive(row: AttentionDisposition | undefined, now: Date): boolean {
  if (!row) return false;
  if (row.state === "dismissed") return true;
  const until = row.snoozedUntil ? new Date(row.snoozedUntil) : null;
  return !!until && !Number.isNaN(until.getTime()) && until.getTime() > now.getTime();
}

