import "server-only";
import { basePrisma, prisma } from "./db";
import { jpegDataUrl } from "./assistantImage";

/**
 * WHAT A PERSON SENDS DAX — a photo, a screenshot, a PDF — HELD, NOT FILED
 * (Sean, 2026-11-02). Two reasons it is kept at all:
 *
 *  - It OUTLIVES ITS MESSAGE BY ONE REPLY: DAX asks "pin the screenshot, or add
 *    its text — and to whom?", and the answer arrives without the picture. So the
 *    upload is handed back for the person's very next question on the same
 *    channel, if that comes within CARRY_MS — and only once: a reply that carried
 *    it does not pass it on (it stays linked to the question it came with).
 *  - A CARD CAN FILE IT LATER: "file this on Anna", "record this payment" name
 *    the upload by id, and Confirm — on WhatsApp within minutes, or on the Ask
 *    page within a day — reads it back, as the person who sent it, and hands it
 *    to the CRM's own upload. So it is kept KEEP_MS, a little over a day, and
 *    deleted by the assistant cron.
 *
 * Never filed anywhere on its own. The bytes are the cleaned JPEG
 * (assistantImage.cleanJpeg, no metadata) for a photo, or the file as sent.
 */
export const CARRY_MS = 30 * 60 * 1000;
export const KEEP_MS = 25 * 60 * 60 * 1000;
/** The biggest file DAX holds. Bigger: the person is told to upload it in the CRM. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type HeldUpload = { id: string; fileName: string; mimeType: string; data: Uint8Array; createdAt: Date };

const DATA_URL = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;

/** A photo's cleaned JPEG data: URL → the file to hold. Null when it is not one. */
export function photoUpload(dataUrl: string): { fileName: string; mimeType: string; data: Buffer } | null {
  const base64 = DATA_URL.exec(dataUrl)?.[1];
  return base64 ? { fileName: "photo.jpg", mimeType: "image/jpeg", data: Buffer.from(base64, "base64") } : null;
}

/** An image upload as the data: URL the model reads (and a note card shows); null for anything else. */
export function uploadImage(upload: Pick<HeldUpload, "mimeType" | "data">): string | null {
  return upload.mimeType === "image/jpeg" ? jpegDataUrl(upload.data) : null;
}

/** Hold what came with a question, before it is answered. Linked to its turn once that is saved (linkUpload). */
export async function holdUpload(tenantId: string, userId: string, file: { fileName: string; mimeType: string; data: Uint8Array }): Promise<string> {
  const row = await prisma.assistantUpload.create({
    data: { tenantId, userId, fileName: file.fileName.slice(0, 200), mimeType: file.mimeType.slice(0, 120), data: new Uint8Array(file.data) },
    select: { id: true },
  });
  return row.id;
}

export async function linkUpload(tenantId: string, userId: string, uploadId: string, turnId: string): Promise<void> {
  await prisma.assistantUpload.updateMany({ where: { id: uploadId, tenantId, userId, turnId: null }, data: { turnId } });
}

/**
 * What came with this person's previous question on `source`, when that question
 * was their last one there, brought something, and was asked within CARRY_MS. Null otherwise.
 */
export async function carriedUpload(tenantId: string, userId: string, source: string, now = new Date()): Promise<HeldUpload | null> {
  const last = await prisma.assistantTurn.findFirst({
    where: { tenantId, userId, source },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
  if (!last || now.getTime() - last.createdAt.getTime() > CARRY_MS) return null;
  return prisma.assistantUpload.findFirst({ where: { tenantId, userId, turnId: last.id }, select: { id: true, fileName: true, mimeType: true, data: true, createdAt: true } });
}

/** One held upload, by id — THIS person's, in this workspace, still kept. What Confirm files. */
export async function heldUpload(tenantId: string, userId: string, id: string, now = new Date()): Promise<HeldUpload | null> {
  return prisma.assistantUpload.findFirst({
    where: { id, tenantId, userId, createdAt: { gt: new Date(now.getTime() - KEEP_MS) } },
    select: { id: true, fileName: true, mimeType: true, data: true, createdAt: true },
  });
}

/** Delete this workspace's held uploads past KEEP_MS. Run by the assistant's cron tick. */
export async function pruneAssistantUploads(tenantId: string, now = new Date()): Promise<number> {
  const removed = await basePrisma.assistantUpload.deleteMany({ where: { tenantId, createdAt: { lt: new Date(now.getTime() - KEEP_MS) } } });
  return removed.count;
}
