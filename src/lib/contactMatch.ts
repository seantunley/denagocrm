import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { PHONE_TAIL_SQL, TAIL_LENGTH, phoneTail } from "./phoneMatch";

/**
 * IS THIS PERSON ALREADY A CUSTOMER? — one answer, for creating a contact from a
 * lead and for the report that looks for the duplicates the old answer made.
 *
 * Contacts used to be matched on the EXACT stored strings, so "Jane@Example.com"
 * and "jane@example.com", or "083 123 4567" and "+27831234567", were strangers
 * and a second contact was created. The rules are now the canonical ones:
 *
 *   email  trimmed, case-insensitive;
 *   phone  the digit tail from lib/phoneMatch.ts — the inbound WhatsApp matcher's
 *          rule — compared against the contact's `phone` AND `whatsapp`.
 *
 * {@link contactIdentitySql} is the single SQL expression of that rule. The
 * lookup below and scripts/report-mark-won-gaps.ts both build their predicate
 * from it, so prevention and the drift report cannot disagree.
 */

/** Canonical email key: trimmed and lower-cased, or null when there is none. */
export function emailKey(raw: string | null | undefined): string | null {
  const key = (raw ?? "").trim().toLowerCase();
  return key || null;
}

/** The {@link emailKey} rule in SQL, for one column. Null for blank. */
export function EMAIL_KEY_SQL(column: string): string {
  return `nullif(lower(btrim(coalesce(${column}, ''))), '')`;
}

/** The {@link phoneTail} rule in SQL: the tail, or NULL when too few digits identify anyone. */
export function PHONE_KEY_SQL(column: string): string {
  return `(CASE WHEN length(${PHONE_TAIL_SQL(column)}) = ${TAIL_LENGTH} THEN ${PHONE_TAIL_SQL(column)} END)`;
}

/**
 * Does the contact aliased `alias` match the identity (`email`, `tail`)? Both
 * are SQL — bound parameters for a lookup, another row's key expressions for the
 * report — and either may be NULL, which matches nothing.
 *
 * The phone side is written with PHONE_TAIL_SQL exactly, so it stays the
 * expression migration 82 indexes.
 */
export function contactIdentitySql(alias: string, email: Prisma.Sql, tail: Prisma.Sql): Prisma.Sql {
  const column = (name: string) => (alias ? `${alias}."${name}"` : `"${name}"`);
  return Prisma.sql`(
    ((${email})::text IS NOT NULL AND ${Prisma.raw(EMAIL_KEY_SQL(column("email")))} = (${email})::text)
    OR ((${tail})::text IS NOT NULL AND (
      ${Prisma.raw(PHONE_TAIL_SQL(column("phone")))} = (${tail})::text
      OR ${Prisma.raw(PHONE_TAIL_SQL(column("whatsapp")))} = (${tail})::text
    ))
  )`;
}

export type ContactMatch =
  | { kind: "none" }
  | { kind: "one"; contactId: string }
  /** More than one live contact matches: the caller must not pick one. */
  | { kind: "ambiguous"; count: number };

/**
 * Find the existing contact for an email/phone, in ONE named workspace.
 *
 * Raw SQL on the bypass client (the normalisation cannot be said through the
 * ORM), so — as in whatsapp.ts's inbound matcher — the tenant and the
 * soft-delete filter are written here rather than assumed.
 *
 * Ambiguity follows the inbound matcher's rule for anything that acts on
 * identity: several candidates is NOT an identity, so the answer is
 * "ambiguous", never the oldest. Linking a lead to the wrong customer is worse
 * than asking.
 */
export async function findExistingContact(input: {
  tenantId: string | null;
  email: string | null | undefined;
  phone: string | null | undefined;
}): Promise<ContactMatch> {
  const email = emailKey(input.email);
  const tail = phoneTail(input.phone);
  if (!email && !tail) return { kind: "none" };
  // Distinct contacts, so three rows means at least three people: enough to
  // know "more than one" without scanning every match.
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Contact"
    WHERE "tenantId" IS NOT DISTINCT FROM ${input.tenantId}
      AND "deletedAt" IS NULL
      AND ${contactIdentitySql("", Prisma.sql`${email}`, Prisma.sql`${tail}`)}
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 3`;
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "one", contactId: rows[0].id };
  return { kind: "ambiguous", count: rows.length };
}

/** The refusal shown when an identity names several customers. */
export function ambiguousContactMessage(count: number): string {
  return `${count > 2 ? "Several" : "Two"} existing customers match this email or phone, so none was picked and no new customer was created. Choose the right customer on the lead first.`;
}
