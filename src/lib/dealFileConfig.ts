import "server-only";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { DEAL_FILE_CHECKLIST_KEY, parseDealFileConfig, supplierDocumentTypes, type DealFileConfig } from "./dealFile";

/** What this workspace's deal file asks for (Settings → Quotes → Deal file checklist). */
export async function getDealFileConfig(): Promise<DealFileConfig> {
  return parseDealFileConfig(await getSetting(DEAL_FILE_CHECKLIST_KEY));
}

/**
 * Every supplier paper type in the workspace: the default supplier list and every live supplier's own. A document of
 * one of these names its supplier — the upload form, DAX and the server all ask with this one list.
 */
export async function workspaceSupplierTypes(tenantId: string | null, config?: DealFileConfig): Promise<string[]> {
  const [settings, vendors] = await Promise.all([
    config ?? getDealFileConfig(),
    tenantId ? prisma.vendor.findMany({ where: { tenantId, deletedAt: null }, select: { requiredDocuments: true } }) : [],
  ]);
  return supplierDocumentTypes(settings, vendors.map((vendor) => vendor.requiredDocuments));
}
