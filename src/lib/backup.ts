import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";

export const PORTABLE_BACKUP_FORMAT = "denagocrm-portable-backup";
export const PORTABLE_BACKUP_VERSION = 3;

export type AssetReference = {
  ref: string;
  kind: string;
};

export type PortableBackup = {
  metadata: {
    format: typeof PORTABLE_BACKUP_FORMAT;
    version: typeof PORTABLE_BACKUP_VERSION;
    exportedAt: string;
    modelCounts: Record<string, number>;
    dataSha256: string;
    assetReferenceCount: number;
  };
  data: Record<string, unknown[]>;
  contactTagLinks: Array<{ contactId: string; tagId: string }>;
  assetReferences: AssetReference[];
};

const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

// Some columns are BigInt (e.g. CustomerCase.number autoincrement, Passkey.counter).
// Plain JSON.stringify throws "Do not know how to serialize a BigInt" the moment
// such a row exists. Encode BigInt as a self-describing tag so export, verification
// and restore all reconstruct the exact value.
const BIGINT_TAG = "$bigint";
function backupReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value;
}
export function stringifyBackup(value: unknown): string {
  return JSON.stringify(value, backupReplacer);
}
/** Walk a parsed backup, turning {"$bigint":"…"} tags back into real BigInt values. */
export function reviveBackupBigInts<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (typeof obj[BIGINT_TAG] === "string" && Object.keys(obj).length === 1) {
        return BigInt(obj[BIGINT_TAG] as string);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * Tables deliberately not exported. Each needs a reason, because the alternative
 * to a justified exclusion is a quietly incomplete backup — which is what this
 * function was.
 */
const EXCLUDED_TABLES = new Set<string>([
  // Prisma's own ledger of which migrations ran. Restoring it into a different
  // database would assert a history that database does not have; the schema comes
  // from prisma/migrations, not from a backup.
  "_prisma_migrations",
]);

/**
 * A table name is interpolated into SQL, so it is VALIDATED rather than trusted.
 * These names come from the database's own catalogue, but "the input is
 * trustworthy" is the assumption every injection starts from.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every table the backup should read, straight from the database. */
export async function backupTableNames(): Promise<string[]> {
  const rows = await basePrisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `;
  return rows.map((row) => row.table_name).filter((name) => !EXCLUDED_TABLES.has(name));
}

/**
 * The key a table's rows appear under. A Prisma model's name where one claims the
 * table, the table name otherwise.
 *
 * Keeping the model name matters for compatibility: every existing backup keys
 * `data.Lead`, and a consumer reading `data.Lead` must keep working. The fallback
 * is what lets a table with no model be exported at all.
 */
export function backupKeyForTable(table: string, tableToModel: Map<string, string>): string {
  return tableToModel.get(table) ?? table;
}

/** Primary-key columns per table, so the export has a deterministic order. */
async function primaryKeyColumns(): Promise<Map<string, string[]>> {
  const rows = await basePrisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT c.relname AS table_name, a.attname AS column_name, k.ord
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE i.indisprimary AND n.nspname = 'public'
     ORDER BY c.relname, k.ord
  `;
  const byTable = new Map<string, string[]>();
  for (const row of rows) {
    const list = byTable.get(row.table_name) ?? [];
    list.push(row.column_name);
    byTable.set(row.table_name, list);
  }
  return byTable;
}

/**
 * Export every table in the database, every column.
 *
 * This used to walk Prisma's model list and call each delegate's `findMany()`,
 * which returns only the fields Prisma DECLARES. Four signing tables used
 * `SELECT *` and were complete; the other ~170 were complete only while the
 * schema matched the database, and it did not. Measured against production on
 * 2026-08-08: 68 columns and 19 whole tables were absent from every backup —
 * StockLocation, StockMovement and StockAttachment entirely, Lead's pipeline and
 * forecast fields, twelve StockUnit fields including the PDI checklist and
 * warranty dates, nine PurchaseOrder cost and date fields, and User.disabledAt.
 *
 * Nothing failed and nothing warned, because a column Prisma does not know about
 * is a column nothing in the application ever looks for in the output.
 *
 * So the table list now comes from the DATABASE rather than from the schema, and
 * every table is read with `SELECT *`. A table added by a migration, or by the
 * preview-branch drift this repo has recorded twice, is included the day it
 * appears instead of the day someone adds a Prisma model for it.
 */
async function exportAllModels(): Promise<Record<string, unknown[]>> {
  const data: Record<string, unknown[]> = {};

  const tableToModel = new Map<string, string>();
  for (const model of Prisma.dmmf.datamodel.models) {
    tableToModel.set(model.dbName ?? model.name, model.name);
  }

  const [tables, primaryKeys] = await Promise.all([backupTableNames(), primaryKeyColumns()]);

  // Sequential, as before: a hundred and sixty concurrent full-table reads would
  // exhaust the connection pool on the one job that must not fail.
  for (const table of tables) {
    if (!SAFE_IDENTIFIER.test(table)) {
      throw new Error(`Refusing to export a table whose name is not a plain identifier: ${table}`);
    }
    // Ordered by primary key where there is one, so two backups of unchanged data
    // are byte-identical and a diff means something. PK columns are always
    // orderable, which an arbitrary first column is not.
    const keys = (primaryKeys.get(table) ?? []).filter((column) => SAFE_IDENTIFIER.test(column));
    const orderBy = keys.length > 0 ? ` ORDER BY ${keys.map((column) => `"${column}"`).join(", ")}` : "";
    data[backupKeyForTable(table, tableToModel)] = await basePrisma.$queryRawUnsafe(
      `SELECT * FROM "${table}"${orderBy}`,
    );
  }

  return data;
}

async function exportContactTagLinks() {
  const contacts = await basePrisma.contact.findMany({
    select: { id: true, tags: { select: { id: true } } },
  });
  return contacts.flatMap((contact) =>
    contact.tags.map((tag) => ({ contactId: contact.id, tagId: tag.id }))
  );
}

/**
 * Every database field that may durably reference stored bytes. Signing evidence
 * is explicitly included rather than inferred from its filed Document: an
 * in-progress envelope has signature PNGs and an unsigned PDF before a final
 * Document exists, while an anomalous completion may have signedPdfRef without a
 * Document row. Missing either is an incomplete legal-evidence restore.
 */
export function collectAssetReferences(data: Record<string, unknown[]>): AssetReference[] {
  const refs = new Map<string, AssetReference>();
  const add = (ref: unknown, kind: string) => {
    if (typeof ref !== "string" || !ref.trim()) return;
    const key = `${kind}:${ref}`;
    if (!refs.has(key)) refs.set(key, { ref, kind });
  };

  for (const row of (data.Document ?? []) as Array<Record<string, unknown>>) {
    add(row.storedName, "document");
    add(row.annotatedStoredName, "document-annotation");
  }
  for (const row of (data.LibraryVersion ?? []) as Array<Record<string, unknown>>) add(row.storedName, "library-version");
  for (const row of (data.Communication ?? []) as Array<Record<string, unknown>>) add(row.attachmentUrl, "communication-attachment");
  for (const row of (data.User ?? []) as Array<Record<string, unknown>>) add(row.drawnSignatureRef, "user-signature");
  for (const row of (data.Quote ?? []) as Array<Record<string, unknown>>) {
    add(row.signatureRef, "quote-customer-signature");
    add(row.deliverySignatureRef, "delivery-signature");
    add(row.dealerSignatureRef, "quote-dealer-signature");
  }
  for (const row of (data.JobCard ?? []) as Array<Record<string, unknown>>) add(row.signatureRef, "jobcard-signature");
  for (const row of (data.PortalUpload ?? []) as Array<Record<string, unknown>>) add(row.storedName, "portal-upload");

  for (const row of (data.SignatureRequest ?? []) as Array<Record<string, unknown>>) {
    add(row.unsignedPdfRef, "signing-unsigned-pdf");
    add(row.signedPdfRef, "signing-sealed-pdf");
  }
  for (const row of (data.SignatureRecipient ?? []) as Array<Record<string, unknown>>) {
    add(row.signatureRef, "signing-recipient-signature");
  }
  for (const row of (data.SignatureField ?? []) as Array<Record<string, unknown>>) {
    if (["signature", "initials", "stamp", "attachment"].includes(String(row.kind ?? ""))) {
      add(row.value, `signing-field-${String(row.kind ?? "asset")}`);
    }
  }
  for (const row of (data.LegalArtifact ?? []) as Array<Record<string, unknown>>) {
    add(row.storageRef, "legal-artifact");
  }

  return [...refs.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref));
}

export async function exportAllData(): Promise<PortableBackup> {
  const data = await exportAllModels();
  const contactTagLinks = await exportContactTagLinks();
  const assetReferences = collectAssetReferences(data);
  const modelCounts = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]));
  const canonicalData = stringifyBackup({ data, contactTagLinks, assetReferences });

  return {
    metadata: {
      format: PORTABLE_BACKUP_FORMAT,
      version: PORTABLE_BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      modelCounts,
      dataSha256: sha256(canonicalData),
      assetReferenceCount: assetReferences.length,
    },
    data,
    contactTagLinks,
    assetReferences,
  };
}

export function verifyPortableBackup(backup: PortableBackup): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (backup.metadata?.format !== PORTABLE_BACKUP_FORMAT) errors.push("Unsupported backup format");
  if (backup.metadata?.version !== PORTABLE_BACKUP_VERSION) errors.push("Unsupported backup version");

  const actualCounts = Object.fromEntries(
    Object.entries(backup.data ?? {}).map(([name, rows]) => [name, Array.isArray(rows) ? rows.length : -1])
  );
  if (JSON.stringify(actualCounts) !== JSON.stringify(backup.metadata?.modelCounts ?? {})) {
    errors.push("Model counts do not match the manifest");
  }

  const actualHash = sha256(stringifyBackup({
    data: backup.data,
    contactTagLinks: backup.contactTagLinks,
    assetReferences: backup.assetReferences,
  }));
  if (actualHash !== backup.metadata?.dataSha256) errors.push("Backup checksum mismatch");
  if ((backup.assetReferences?.length ?? 0) !== backup.metadata?.assetReferenceCount) {
    errors.push("Asset reference count does not match the manifest");
  }

  // A backup containing signing state but not the custody tables is not a valid
  // version-3 paperless-system backup, even if its JSON checksum is internally
  // consistent.
  for (const required of ["SigningJob", "SigningIdentityChallenge", "LegalArtifact", "LegalArtifactValidation"]) {
    if (!Array.isArray(backup.data?.[required])) errors.push(`Missing signing trust table: ${required}`);
  }

  return { ok: errors.length === 0, errors };
}
