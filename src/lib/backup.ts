import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";

export const PORTABLE_BACKUP_FORMAT = "denagocrm-portable-backup";
export const PORTABLE_BACKUP_VERSION = 3;
export type AssetReference = { ref: string; kind: string };

const SIGNING_TRUST_TABLES = [
  "SigningUploadIntent", "SigningArtifact", "LegalArtifact", "SigningOutboxJob", "SigningDelivery", "SigningIdentityChallenge",
  "SigningEvidenceAnchor", "LegalArtifactDestructionRequest", "SigningRecoveryAction",
] as const;

export type PortableBackup = {
  metadata: {
    format: typeof PORTABLE_BACKUP_FORMAT;
    version: typeof PORTABLE_BACKUP_VERSION;
    exportedAt: string;
    modelCounts: Record<string, number>;
    signingTrustCounts: Record<string, number>;
    dataSha256: string;
    assetReferenceCount: number;
  };
  data: Record<string, unknown[]>;
  signingTrustData: Record<string, unknown[]>;
  contactTagLinks: Array<{ contactId: string; tagId: string }>;
  assetReferences: AssetReference[];
};

const lowerFirst = (value: string) => value.charAt(0).toLowerCase() + value.slice(1);
const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const BIGINT_TAG = "$bigint";
function backupReplacer(_key: string, value: unknown) { return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value; }
export function stringifyBackup(value: unknown): string { return JSON.stringify(value, backupReplacer); }
export function reviveBackupBigInts<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const object = node as Record<string, unknown>;
      if (typeof object[BIGINT_TAG] === "string" && Object.keys(object).length === 1) return BigInt(object[BIGINT_TAG] as string);
      return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };
  return walk(value) as T;
}

async function exportAllModels(): Promise<Record<string, unknown[]>> {
  const client = basePrisma as unknown as Record<string, { findMany: () => Promise<unknown[]> }>;
  const data: Record<string, unknown[]> = {};
  for (const model of Prisma.dmmf.datamodel.models) {
    const delegate = client[lowerFirst(model.name)];
    if (!delegate?.findMany) throw new Error(`Backup delegate missing for Prisma model ${model.name}`);
    data[model.name] = await delegate.findMany();
  }
  return data;
}

async function exportSigningTrustTables(): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of SIGNING_TRUST_TABLES) {
    // Table names are a closed compile-time allowlist, never user input.
    result[table] = await basePrisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table}" ORDER BY id`);
  }
  return result;
}

async function exportContactTagLinks() {
  const contacts = await basePrisma.contact.findMany({ select: { id: true, tags: { select: { id: true } } } });
  return contacts.flatMap((contact) => contact.tags.map((tag) => ({ contactId: contact.id, tagId: tag.id })));
}

function collectAssetReferences(data: Record<string, unknown[]>, signing: Record<string, unknown[]>): AssetReference[] {
  const refs = new Map<string, AssetReference>();
  const add = (ref: unknown, kind: string) => {
    if (typeof ref !== "string" || !ref.trim()) return;
    const key = `${kind}:${ref}`;
    if (!refs.has(key)) refs.set(key, { ref, kind });
  };
  for (const row of (data.Document ?? []) as Array<Record<string, unknown>>) { add(row.storedName, "document"); add(row.annotatedStoredName, "document-annotation"); }
  for (const row of (data.LibraryVersion ?? []) as Array<Record<string, unknown>>) add(row.storedName, "library-version");
  for (const row of (data.Communication ?? []) as Array<Record<string, unknown>>) add(row.attachmentUrl, "communication-attachment");
  for (const row of (data.User ?? []) as Array<Record<string, unknown>>) { add(row.drawnSignatureRef, "user-signature"); add(row.avatarRef, "user-avatar"); }
  for (const row of (data.Quote ?? []) as Array<Record<string, unknown>>) { add(row.signatureRef, "quote-customer-signature"); add(row.deliverySignatureRef, "delivery-signature"); add(row.dealerSignatureRef, "quote-dealer-signature"); }
  for (const row of (data.JobCard ?? []) as Array<Record<string, unknown>>) add(row.signatureRef, "jobcard-signature");
  for (const row of (data.PortalUpload ?? []) as Array<Record<string, unknown>>) add(row.storedName, "portal-upload");
  for (const row of (data.SignatureRequest ?? []) as Array<Record<string, unknown>>) { add(row.unsignedPdfRef, "signing-unsigned-pdf"); add(row.signedPdfRef, "signing-signed-pdf"); }
  for (const row of (data.SignatureRecipient ?? []) as Array<Record<string, unknown>>) add(row.signatureRef, "signing-recipient-signature");
  for (const row of (data.SignatureField ?? []) as Array<Record<string, unknown>>) {
    if (["signature", "initials", "stamp"].includes(String(row.kind))) add(row.value, "signing-field-image");
  }
  for (const row of (signing.SigningArtifact ?? []) as Array<Record<string, unknown>>) add(row.objectRef, `signing-artifact-${String(row.kind || "unknown")}`);
  for (const row of (signing.LegalArtifact ?? []) as Array<Record<string, unknown>>) { add(row.objectRef, "legal-artifact"); add(row.timestampTokenRef, "trusted-timestamp"); }
  return [...refs.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref));
}

export async function exportAllData(): Promise<PortableBackup> {
  const [data, signingTrustData, contactTagLinks] = await Promise.all([exportAllModels(), exportSigningTrustTables(), exportContactTagLinks()]);
  const assetReferences = collectAssetReferences(data, signingTrustData);
  const modelCounts = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]));
  const signingTrustCounts = Object.fromEntries(Object.entries(signingTrustData).map(([name, rows]) => [name, rows.length]));
  const canonical = stringifyBackup({ data, signingTrustData, contactTagLinks, assetReferences });
  return {
    metadata: {
      format: PORTABLE_BACKUP_FORMAT, version: PORTABLE_BACKUP_VERSION, exportedAt: new Date().toISOString(),
      modelCounts, signingTrustCounts, dataSha256: sha256(canonical), assetReferenceCount: assetReferences.length,
    },
    data, signingTrustData, contactTagLinks, assetReferences,
  };
}

export function verifyPortableBackup(backup: PortableBackup): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (backup.metadata?.format !== PORTABLE_BACKUP_FORMAT) errors.push("Unsupported backup format");
  if (backup.metadata?.version !== PORTABLE_BACKUP_VERSION) errors.push("Unsupported backup version");
  const actualCounts = Object.fromEntries(Object.entries(backup.data ?? {}).map(([name, rows]) => [name, Array.isArray(rows) ? rows.length : -1]));
  const signingCounts = Object.fromEntries(Object.entries(backup.signingTrustData ?? {}).map(([name, rows]) => [name, Array.isArray(rows) ? rows.length : -1]));
  if (JSON.stringify(actualCounts) !== JSON.stringify(backup.metadata?.modelCounts ?? {})) errors.push("Model counts do not match the manifest");
  if (JSON.stringify(signingCounts) !== JSON.stringify(backup.metadata?.signingTrustCounts ?? {})) errors.push("Signing trust counts do not match the manifest");
  const actualHash = sha256(stringifyBackup({ data: backup.data, signingTrustData: backup.signingTrustData, contactTagLinks: backup.contactTagLinks, assetReferences: backup.assetReferences }));
  if (actualHash !== backup.metadata?.dataSha256) errors.push("Backup checksum mismatch");
  if ((backup.assetReferences?.length ?? 0) !== backup.metadata?.assetReferenceCount) errors.push("Asset reference count does not match the manifest");
  return { ok: errors.length === 0, errors };
}
