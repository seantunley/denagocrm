/**
 * What this workspace calls its three main records (Settings → Company profile → Names for records), so a business
 * that isn't a dealer can say "Enquiry", "Matter" or "Work order". Labels only: the menu, page titles, buttons and
 * the deal page. DAX, help articles, documents and emails keep the built-in words.
 * Pure — the server reader is getRecordLabels in recordLabelsServer.ts.
 */

export const RECORD_LABELS_KEY = "RECORD_LABELS";
export type RecordKind = "lead" | "deal" | "jobcard";
export type RecordLabel = { one: string; many: string };
export type RecordLabels = Record<RecordKind, RecordLabel>;

export const DEFAULT_RECORD_LABELS: RecordLabels = {
  lead: { one: "Lead", many: "Leads" },
  deal: { one: "Deal", many: "Deals" },
  jobcard: { one: "Job card", many: "Job cards" },
};
export const RECORD_KINDS = Object.keys(DEFAULT_RECORD_LABELS) as RecordKind[];
const MAX = 30;

const tidy = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX) : "");

/** A saved value read defensively: each word missing, blank or broken falls back to the built-in one. */
export function parseRecordLabels(raw: string | null | undefined): RecordLabels {
  let saved: Record<string, Record<string, unknown>> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch {
    /* fall back to the defaults */
  }
  const out = {} as RecordLabels;
  for (const kind of RECORD_KINDS) {
    const entry = saved[kind] && typeof saved[kind] === "object" ? saved[kind] : {};
    out[kind] = { one: tidy(entry.one) || DEFAULT_RECORD_LABELS[kind].one, many: tidy(entry.many) || DEFAULT_RECORD_LABELS[kind].many };
  }
  return out;
}

export const isCustom = (labels: RecordLabels, kind: RecordKind) =>
  labels[kind].one !== DEFAULT_RECORD_LABELS[kind].one || labels[kind].many !== DEFAULT_RECORD_LABELS[kind].many;

/** For the middle of a sentence ("New lead"): first letter lowered, unless the word is an acronym ("RFQ"). */
export function midSentence(word: string): string {
  return /^[A-Z]{2}/.test(word) ? word : word.charAt(0).toLowerCase() + word.slice(1);
}

/** "Job #12" with the built-in words; "Matter #12" once the workspace names job cards itself. */
export function jobNumberLabel(labels: RecordLabels, n: number | string): string {
  return `${isCustom(labels, "jobcard") ? labels.jobcard.one : "Job"} #${n}`;
}

/** Menu links to rename: only the customised ones, so a workspace on the built-in words sees its menu unchanged. */
export function navLabelOverrides(labels: RecordLabels): Record<string, string> {
  const out: Record<string, string> = {};
  if (isCustom(labels, "lead")) out["/leads"] = labels.lead.many;
  if (isCustom(labels, "jobcard")) out["/jobcards"] = labels.jobcard.many;
  return out;
}
