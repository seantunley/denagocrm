import { contactKind } from "./contactKind";

/**
 * The contact edit form, filled in from the record as it stands, with `changes` on top — what DAX's
 * update_customer hands to updateContact (Sean, 2026-11-02: "Anna's new number is…").
 *
 * WHY THE WHOLE RECORD. updateContact saves EVERY field from what is posted (contacts.ts contactData): a
 * field left out is saved empty, the marketing opt-out as "may be marketed to", the owner as unassigned, the
 * tags as none. So a change to one field posts all of them, as they are. tests/contactFormFor.test.ts fails
 * if contactData learns a field this does not post.
 */
export type ContactRecord = {
  isCompany: boolean;
  fleetId: string | null;
  firstName: string;
  lastName: string | null;
  company: string | null;
  vatNumber: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  address: string | null;
  suburb: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  source: string | null;
  notes: string | null;
  ownerId: string | null;
  marketingOptOut: boolean;
  tags: { name: string }[];
  birthDay: number | null;
  birthMonth: number | null;
  birthYear: number | null;
};

/** Posted as text, as the form posts them. */
export const POSTED_TEXT_FIELDS = [
  "firstName", "lastName", "company", "vatNumber", "email", "phone", "whatsapp",
  "address", "suburb", "city", "province", "postalCode", "source", "notes",
] as const;

export function contactFormFor(record: ContactRecord, changes: Partial<Record<(typeof POSTED_TEXT_FIELDS)[number], string>>): FormData {
  const form = new FormData();
  form.set("contactKind", contactKind(record));
  if (record.fleetId) form.set("fleetId", record.fleetId);
  for (const field of POSTED_TEXT_FIELDS) {
    const value = changes[field] ?? record[field];
    if (value != null && value !== "") form.set(field, value);
  }
  if (record.ownerId) form.set("ownerId", record.ownerId);
  if (record.marketingOptOut) form.set("marketingOptOut", "on");
  // The birthday as it stands (blank when there is none), so a card that changes something else keeps it.
  for (const field of ["birthDay", "birthMonth", "birthYear"] as const) form.set(field, record[field] == null ? "" : String(record[field]));
  form.set("tags", record.tags.map((tag) => tag.name).join(","));
  return form;
}
