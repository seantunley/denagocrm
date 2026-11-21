/**
 * WARRANTY IN PARTS (Sean, 2026-11-21: "5 Years on the Battery, 2 years on the cart and lifetime on the chassis. But the
 * warranty details need to be captured per vehicle. The bike will have different warranties."). Pure.
 *
 * - A PRODUCT carries its terms: a short list of parts, each covered for some months or for life (time only — no
 *   mileage limits, Sean 2026-11-21).
 * - A VEHICLE gets its own copy when it is delivered, dated from the delivery day (decided 2026-11-21), so changing a
 *   product's terms later never rewrites cover already given. Staff with warranty.manage can change one vehicle's.
 * - Part names come from the workspace's own list (Settings-editable dropdown, never free text).
 */

import { addMonths } from "date-fns";

export type WarrantyTerm = { part: string; months: number | null };
export type PartStatus = "active" | "expired" | "lifetime";
export type PartCover = WarrantyTerm & { until: Date | null; status: PartStatus };

export const WARRANTY_PARTS_KEY = "WARRANTY_PARTS";
export const DEFAULT_WARRANTY_PARTS = ["Battery", "Cart", "Chassis"];
export const MAX_TERMS = 12;
/** 50 years: beyond it a term is "Lifetime", which is said as such. */
export const MAX_MONTHS = 600;
const PART_MAX = 40;

/** The workspace's part names from the stored setting (one per line), or the defaults when it was never set. */
export function parsePartList(value: string | null | undefined): string[] {
  if (value == null) return [...DEFAULT_WARRANTY_PARTS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split("\n")) {
    const part = raw.trim().slice(0, PART_MAX);
    if (part && !seen.has(part.toLowerCase())) {
      seen.add(part.toLowerCase());
      out.push(part);
    }
  }
  return out.slice(0, 30);
}

/** Stored terms (JSON) → a clean list: known shape only, one row per part, at most MAX_TERMS. Junk is dropped. */
export function parseTerms(value: unknown): WarrantyTerm[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: WarrantyTerm[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const part = typeof (row as { part?: unknown }).part === "string" ? (row as { part: string }).part.trim().slice(0, PART_MAX) : "";
    const raw = (row as { months?: unknown }).months;
    const months = raw === null ? null : Number.isInteger(raw) && (raw as number) >= 1 && (raw as number) <= MAX_MONTHS ? (raw as number) : undefined;
    if (!part || months === undefined || seen.has(part.toLowerCase())) continue;
    seen.add(part.toLowerCase());
    out.push({ part, months });
  }
  return out.slice(0, MAX_TERMS);
}

/**
 * The terms posted by the editor (rows `part_N`, `length_N`, `unit_N` = months | years | lifetime), checked against the
 * workspace's part list. Returns the terms, or why they can't be saved.
 */
export function termsFromForm(form: FormData, parts: readonly string[]): { ok: true; terms: WarrantyTerm[] } | { ok: false; error: string } {
  const allowed = new Map(parts.map((p) => [p.toLowerCase(), p]));
  const terms: WarrantyTerm[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < MAX_TERMS; i++) {
    const picked = String(form.get(`part_${i}`) ?? "").trim();
    if (!picked) continue;
    const part = allowed.get(picked.toLowerCase());
    if (!part) return { ok: false, error: `"${picked}" isn't one of your warranty parts. Add it in Settings → Warranty parts first.` };
    if (seen.has(part.toLowerCase())) return { ok: false, error: `${part} is listed twice.` };
    seen.add(part.toLowerCase());
    const unit = String(form.get(`unit_${i}`) ?? "years");
    if (unit === "lifetime") {
      terms.push({ part, months: null });
      continue;
    }
    const length = Number(String(form.get(`length_${i}`) ?? "").trim());
    const months = unit === "months" ? length : length * 12;
    if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) {
      return { ok: false, error: `Give ${part} a length that comes to whole months (at least 1) — or choose Lifetime.` };
    }
    terms.push({ part, months });
  }
  return { ok: true, terms };
}

/**
 * The day cover on a part ends: the same calendar day `months` later, clamped to the month's last day (31 Jan + 1 month
 * = 28/29 Feb, never 3 Mar). The same date-fns addMonths the single-term warranty (lib/warranty.ts) uses. Null for life.
 */
export function termEnd(start: Date, months: number | null): Date | null {
  if (months == null) return null;
  return addMonths(start, months);
}

/** Each part's cover on `now`, from the vehicle's start date. */
export function coverOf(terms: readonly WarrantyTerm[], start: Date, now: Date): PartCover[] {
  return terms.map((t) => {
    const until = termEnd(start, t.months);
    return { ...t, until, status: until == null ? "lifetime" : now <= until ? "active" : "expired" };
  });
}

/** What a new vehicle copies from its product: its terms, starting on `startsAt` (the delivery day). Nothing if none. */
export function vehicleWarrantyFrom(productTerms: unknown, startsAt: Date): { warrantyParts?: WarrantyTerm[]; warrantyStartsAt?: Date } {
  const terms = parseTerms(productTerms);
  return terms.length > 0 ? { warrantyParts: terms, warrantyStartsAt: startsAt } : {};
}

/**
 * A vehicle's cover by part. Its own parts when it has them; otherwise the single term it always had (purchase date +
 * warrantyMonths) as one row, so a vehicle from before parts reads exactly as it did. Empty: no warranty recorded.
 */
export function vehicleCover(
  v: { warrantyParts: unknown; warrantyStartsAt: Date | null; purchaseDate: Date | null; warrantyMonths: number | null },
  now: Date,
): PartCover[] {
  const terms = parseTerms(v.warrantyParts);
  if (terms.length > 0 && v.warrantyStartsAt) return coverOf(terms, v.warrantyStartsAt, now);
  if (v.warrantyMonths && v.purchaseDate) return coverOf([{ part: "Warranty", months: v.warrantyMonths }], v.purchaseDate, now);
  return [];
}

/** "5 years", "18 months", "Lifetime". */
export function termLabel(months: number | null): string {
  if (months == null) return "Lifetime";
  if (months % 12 === 0) return months === 12 ? "1 year" : `${months / 12} years`;
  return months === 1 ? "1 month" : `${months} months`;
}

/** The editor's rows for stored terms: whole years shown as years. */
export function termRows(terms: readonly WarrantyTerm[]): { part: string; length: string; unit: "years" | "months" | "lifetime" }[] {
  return terms.map((t) =>
    t.months == null
      ? { part: t.part, length: "", unit: "lifetime" }
      : t.months % 12 === 0
        ? { part: t.part, length: String(t.months / 12), unit: "years" }
        : { part: t.part, length: String(t.months), unit: "months" },
  );
}

/** One line for a timeline or DAX: "Battery 5 years (until 21 Nov 2031) · Chassis Lifetime". */
export function coverSummary(cover: readonly PartCover[], date: (d: Date) => string): string {
  return cover
    .map((c) => `${c.part} ${termLabel(c.months)}${c.until ? ` (${c.status === "expired" ? "ended" : "until"} ${date(c.until)})` : ""}`)
    .join(" · ");
}
