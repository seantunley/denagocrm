"use server";

import { prisma } from "@/lib/db";
import { ciExactIdFilter } from "@/lib/ciExact";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { withActingStaffScope } from "@/lib/actingScope";

export type ImportState = { ok?: string; error?: string };

/** Minimal CSV parser with quoted-field support. */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const HEADER_MAP: Record<string, string> = {
  name: "name", "full name": "name", fullname: "name",
  "first name": "firstName", firstname: "firstName", first: "firstName", first_name: "firstName",
  "last name": "lastName", lastname: "lastName", surname: "lastName", last: "lastName", last_name: "lastName",
  email: "email", "e-mail": "email", "email address": "email",
  phone: "phone", mobile: "phone", cell: "phone", tel: "phone", telephone: "phone", "phone number": "phone",
  whatsapp: "whatsapp",
  company: "company", organisation: "company", organization: "company",
  address: "address", suburb: "suburb", city: "city", town: "city",
  province: "province", "postal code": "postalCode", postcode: "postalCode", zip: "postalCode",
  notes: "notes", source: "source",
};

export async function importContacts(
  _prev: ImportState | undefined,
  formData: FormData
): Promise<ImportState> {
  return withActingStaffScope(async () => {
    const user = await requireOwner();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file first." };
    if (file.size > 5 * 1024 * 1024) return { error: "File too large (max 5 MB)." };

    const rows = parseCSV(await file.text());
    if (rows.length < 2) return { error: "The CSV needs a header row plus at least one contact." };

    const headers = rows[0].map((h) => HEADER_MAP[h.trim().toLowerCase()] ?? null);
    if (!headers.some((h) => h === "name" || h === "firstName")) {
      return { error: "No name column found. Expected a header like Name / First Name." };
    }

    let created = 0, skippedDupe = 0, skippedEmpty = 0;
    for (const raw of rows.slice(1)) {
      const rec: Record<string, string> = {};
      raw.forEach((val, i) => {
        const key = headers[i];
        if (key && val.trim()) rec[key] = val.trim();
      });
      let firstName = rec.firstName ?? "";
      let lastName = rec.lastName ?? "";
      if (!firstName && rec.name) {
        const parts = rec.name.split(/\s+/);
        firstName = parts[0];
        lastName = parts.slice(1).join(" ");
      }
      if (!firstName) { skippedEmpty++; continue; }

      // Exact (case-folded) email match. Under `mode: "insensitive"` this was an
      // unescaped ILIKE, so a CSV row whose email contained `_` or `%` matched an
      // unrelated contact and the row was silently dropped as a duplicate — the
      // import reported a clean run while quietly discarding real records.
      const matchers = [
        ...(rec.email ? [await ciExactIdFilter("contactEmail", rec.email)] : []),
        ...(rec.phone ? [{ phone: rec.phone }] : []),
      ];
      if (matchers.length > 0) {
        const existing = await prisma.contact.findFirst({ where: { OR: matchers } });
        if (existing) { skippedDupe++; continue; }
      }

      await prisma.contact.create({
        data: {
          firstName,
          lastName: lastName || null,
          email: rec.email ?? null,
          phone: rec.phone ?? null,
          whatsapp: rec.whatsapp ?? null,
          company: rec.company ?? null,
          address: rec.address ?? null,
          suburb: rec.suburb ?? null,
          city: rec.city ?? null,
          province: rec.province ?? null,
          postalCode: rec.postalCode ?? null,
          notes: rec.notes ?? null,
          source: rec.source ?? "import",
          createdById: user.id,
        },
      });
      created++;
    }

    await logAudit({
      action: "contact.imported",
      summary: `Imported ${created} contacts from CSV (${skippedDupe} duplicates skipped)`,
      user,
    });
    revalidatePath("/contacts");
    return {
      ok: `Imported ${created} contact${created !== 1 ? "s" : ""}. Skipped ${skippedDupe} duplicate${skippedDupe !== 1 ? "s" : ""} and ${skippedEmpty} row${skippedEmpty !== 1 ? "s" : ""} without a name.`,
    };
  });
}
