import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";

export const PORTABLE_BACKUP_FORMAT = "denagocrm-portable-backup";
export const PORTABLE_BACKUP_VERSION = 2;

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

const lowerFirst = (value: string) => value.charAt(0).toLowerCase() + value.slice(1);
const sha256 = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * Exports every Prisma model through the raw client. This intentionally uses the
 * Prisma DMMF so newly-added models are included automatically instead of being
 * silently omitted from a hand-maintained backup list.
 */
async function exportAllModels(): Promise<Record<string, unknown[]>> {
  const client = basePrisma as unknown as Record<string, { findMany: () => Promise<unknown[]> }>;
  const data: Record<string, unknown[]> = {};

  for (const model of Prisma.dmmf.datamodel.models) {
    const delegateName = lowerFirst(model.name);
    const delegate = client[delegateName];
    if (!delegate?.findMany) throw new Error(`Backup delegate missing for Prisma model ${model.name}`);
    data[model.name] = await delegate.findMany();
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

function collectAssetReferences(data: Record<string, unknown[]>): AssetReference[] {
  const refs = new Map<string, AssetReference>();
  const add = (ref: unknown, kind: string) => {
    if (typeof ref !== "string" || !ref.trim()) return;
    const key = `${kind}:${ref}`;
    if (!refs.has(key)) refs.set(key, { ref, kind });
  };

  for (const row of (data.Document ?? []) as Array<Record<string, unknown>>) add(row.storedName, "document");
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

  return [...refs.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref));
}

export async function exportAllData(): Promise<PortableBackup> {
  const data = await exportAllModels();
  const contactTagLinks = await exportContactTagLinks();
  const assetReferences = collectAssetReferences(data);
  const modelCounts = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]));
  const canonicalData = JSON.stringify({ data, contactTagLinks, assetReferences });

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

  const actualHash = sha256(JSON.stringify({
    data: backup.data,
    contactTagLinks: backup.contactTagLinks,
    assetReferences: backup.assetReferences,
  }));
  if (actualHash !== backup.metadata?.dataSha256) errors.push("Backup checksum mismatch");
  if ((backup.assetReferences?.length ?? 0) !== backup.metadata?.assetReferenceCount) {
    errors.push("Asset reference count does not match the manifest");
  }

  return { ok: errors.length === 0, errors };
}
