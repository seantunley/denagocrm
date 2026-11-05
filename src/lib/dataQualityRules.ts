import { phoneTail } from "./phoneMatch";

/**
 * DATA QUALITY CENTRE — the pure half (the database half is dataQuality.ts). Each check is a plain question about one
 * record, with the sentence the page shows; the score is the share of records with no problem. Duplicates use the same
 * identity rules as the Duplicates page (lib/contactMatch.ts, lib/phoneMatch.ts).
 */

export type ContactFacts = { id: string; email: string | null; phone: string | null; whatsapp: string | null; ownerId: string | null; source: string | null };
export type DealFacts = {
  id: string; status: string; contactId: string | null; valueCents: number | null; assignedToId: string | null;
  email: string | null; phone: string | null; contact: { email: string | null; phone: string | null } | null;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = (s: string) => s.replace(/\D/g, "").length;
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export type Check<T> = { key: string; label: string; why: string; problem: (row: T) => boolean };

export const CONTACT_CHECKS: Check<ContactFacts>[] = [
  { key: "unreachable", label: "No way to reach them", why: "No email, phone or WhatsApp number — nobody can follow up.", problem: (c) => !c.email && !c.phone && !c.whatsapp },
  { key: "no_owner", label: "No owner", why: "Nobody is responsible for this customer, so nobody is reminded about them.", problem: (c) => !c.ownerId },
  { key: "no_source", label: "Unknown source", why: "Where they came from isn't recorded, so marketing can't be measured.", problem: (c) => !c.source?.trim() },
  { key: "bad_email", label: "Email looks wrong", why: "The email address isn't in a valid form — mail to it will bounce.", problem: (c) => Boolean(c.email) && !EMAIL.test(c.email!.trim()) },
  { key: "bad_phone", label: "Phone looks wrong", why: "The phone number is too short or too long to be a real number.", problem: (c) => Boolean(c.phone) && (digits(c.phone!) < 9 || digits(c.phone!) > 15) },
];

export const DEAL_CHECKS: Check<DealFacts>[] = [
  { key: "no_customer", label: "Open deal with no customer", why: "The deal isn't linked to a customer record, so its history is split.", problem: (d) => d.status === "open" && !d.contactId },
  { key: "no_value", label: "Open deal with no value", why: "Without a value the pipeline and forecast undercount.", problem: (d) => d.status === "open" && !d.valueCents },
  { key: "no_owner", label: "Open deal with no owner", why: "Nobody is working this deal.", problem: (d) => d.status === "open" && !d.assignedToId },
  {
    key: "conflict",
    label: "Deal and customer disagree",
    why: "The deal has a different email or phone from its customer — one of them is out of date.",
    problem: (d) => {
      if (!d.contact) return false;
      const emailClash = Boolean(d.email && d.contact.email) && !sameEmail(d.email!, d.contact.email!);
      const a = phoneTail(d.phone);
      const b = phoneTail(d.contact.phone);
      return emailClash || (Boolean(a && b) && a !== b);
    },
  },
];

/** Per check: the records failing it. */
export function failing<T extends { id: string }>(rows: readonly T[], checks: readonly Check<T>[]): Record<string, T[]> {
  return Object.fromEntries(checks.map((check) => [check.key, rows.filter((row) => check.problem(row))]));
}

/** The share (0–100) of records with no problem at all. An empty list scores 100. */
export function cleanShare<T>(rows: readonly T[], checks: readonly Check<T>[]): number {
  if (!rows.length) return 100;
  const clean = rows.filter((row) => !checks.some((check) => check.problem(row))).length;
  return Math.round((clean / rows.length) * 100);
}

/** Customers by where they came from, most first; blank as "Unknown". */
export function bySource(rows: readonly ContactFacts[], take = 8): { source: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const source = row.source?.trim() || "Unknown";
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return [...counts.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count).slice(0, take);
}

/** "2026-11-05" in South Africa — one monitoring snapshot per workspace per day. */
export function snapshotDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
