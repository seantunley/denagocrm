import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { contactName } from "./format";
import { sendPushToAll } from "./push";
import { hashSignToken } from "./signing/tokens";
import { SECURE_LINK_TOKEN, secureLinkState, type SecureLinkState } from "./secureLinks";

export type SecureFile = { fileName: string; storedRef: string; mimeType: string; sizeBytes: number };

/**
 * Make one secure link per file. Returns the RAW token for each — the only time
 * it exists outside the email: the table keeps its SHA-256, so a copy of the
 * database opens nothing.
 */
export async function createSecureLinks(input: {
  tenantId: string;
  files: readonly SecureFile[];
  expiresAt: Date;
  createdById: string;
  sentTo: string;
  contactId?: string | null;
  leadId?: string | null;
}): Promise<{ id: string; token: string; fileName: string; sizeBytes: number }[]> {
  const made: { id: string; token: string; fileName: string; sizeBytes: number }[] = [];
  for (const file of input.files) {
    const token = randomBytes(32).toString("base64url");
    const row = await prisma.secureFileLink.create({
      data: {
        tenantId: input.tenantId,
        token: hashSignToken(token),
        fileName: file.fileName.slice(0, 200),
        storedRef: file.storedRef,
        mimeType: file.mimeType || "application/octet-stream",
        sizeBytes: file.sizeBytes,
        sentTo: input.sentTo.slice(0, 500),
        contactId: input.contactId ?? null,
        leadId: input.leadId ?? null,
        createdById: input.createdById,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    });
    made.push({ id: row.id, token, fileName: file.fileName, sizeBytes: file.sizeBytes });
  }
  return made;
}

/** The email these links rode in, once it is on the timeline. */
export async function attachSecureLinksToEmail(tenantId: string, ids: readonly string[], communicationId: string): Promise<void> {
  if (ids.length === 0) return;
  await prisma.secureFileLink.updateMany({ where: { tenantId, id: { in: [...ids] } }, data: { communicationId } });
}

/**
 * The email never went: these links must not be left working. The files they
 * point at are not deleted here — a library file belongs to the library, and an
 * upload is simply never reachable again.
 */
export async function discardSecureLinks(tenantId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.secureFileLink.updateMany({ where: { tenantId, id: { in: [...ids] }, revokedAt: null }, data: { revokedAt: new Date() } });
}

export type SecureLinkView = {
  id: string;
  tenantId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storedRef: string;
  expiresAt: Date;
  state: SecureLinkState;
};

/** What a link in someone's hand leads to, and whether it still works. Reads only. Null for an unknown link. */
export async function findSecureLink(token: string): Promise<SecureLinkView | null> {
  if (!SECURE_LINK_TOKEN.test(token)) return null;
  const link = await prisma.secureFileLink.findUnique({
    where: { token: hashSignToken(token) },
    select: { id: true, tenantId: true, fileName: true, mimeType: true, sizeBytes: true, storedRef: true, expiresAt: true, revokedAt: true },
  });
  if (!link) return null;
  return { ...link, state: secureLinkState(link, new Date()) };
}

/**
 * Record a download and tell the sender the first time — the read receipt.
 *
 * "First" is decided by the database in one statement, so two downloads
 * arriving together notify once. Run after the file has started on its way; a
 * failure here is logged by the caller and never costs the customer their file.
 */
export async function recordSecureDownload(link: Pick<SecureLinkView, "id" | "tenantId" | "fileName">): Promise<void> {
  const { id, tenantId } = link;
  const now = new Date();
  await prisma.secureFileLink.updateMany({ where: { id, tenantId }, data: { openCount: { increment: 1 }, lastOpenedAt: now } });
  const first = (await prisma.secureFileLink.updateMany({ where: { id, tenantId, firstOpenedAt: null }, data: { firstOpenedAt: now } })).count === 1;
  if (!first) return;
  const row = await prisma.secureFileLink.findFirst({ where: { id, tenantId }, select: { createdById: true, contactId: true, leadId: true } });
  if (!row) return;
  const [contact, lead] = await Promise.all([
    row.contactId ? prisma.contact.findFirst({ where: { id: row.contactId, tenantId } }) : null,
    row.leadId ? prisma.lead.findFirst({ where: { id: row.leadId, tenantId }, select: { name: true } }) : null,
  ]);
  const who = contact ? contactName(contact) : lead?.name || "The recipient";
  await sendPushToAll(
    {
      title: "File downloaded",
      body: `${who} downloaded “${link.fileName.slice(0, 80)}”`,
      url: row.leadId ? `/leads/${row.leadId}` : row.contactId ? `/contacts/${row.contactId}` : "/",
    },
    "secure_link_opened",
    { tenantId, userId: row.createdById },
  ).catch(() => 0);
}

/** The secure links sent on one customer record, newest first — for the panel staff see. No stored refs, no tokens. */
export async function secureLinksFor(tenantId: string, where: { contactId: string } | { leadId: string }, take = 20) {
  return prisma.secureFileLink.findMany({
    where: { tenantId, ...where },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, fileName: true, sizeBytes: true, sentTo: true, createdAt: true, expiresAt: true, revokedAt: true, firstOpenedAt: true, openCount: true },
  });
}
