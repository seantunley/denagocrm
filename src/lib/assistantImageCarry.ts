import "server-only";
import { basePrisma, prisma } from "./db";
import { jpegDataUrl } from "./assistantImage";

/**
 * A SCREENSHOT OUTLIVES ITS MESSAGE BY ONE REPLY (Sean, 2026-11-02: "when a
 * screenshot arrives to DAX, it must ask to pin the screenshot or read and add
 * the text"). DAX asks; the answer ("pin it to Clive") arrives without the
 * picture. So a photo that came WITH a question is kept, and handed back for the
 * person's very next question on the same channel if that comes within
 * CARRY_MS — only then, and only once: a reply that itself carried it does not
 * pass it on (askCrm saves a carried image under no turn). Deleted by the
 * assistant cron after KEEP_MS.
 */
export const CARRY_MS = 30 * 60 * 1000;
export const KEEP_MS = 60 * 60 * 1000;

const DATA_URL = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;

/** Keep the photo that came with this turn's question (a cleaned JPEG data: URL). */
export async function rememberImage(tenantId: string, userId: string, turnId: string, dataUrl: string): Promise<void> {
  const base64 = DATA_URL.exec(dataUrl)?.[1];
  if (!base64) return;
  await prisma.assistantImage.create({ data: { tenantId, userId, turnId, jpeg: Buffer.from(base64, "base64") } });
}

/**
 * The photo from this person's previous question on `source`, when that question
 * was their last one there, brought a photo, and was asked within CARRY_MS. Null otherwise.
 */
export async function carriedImage(tenantId: string, userId: string, source: string, now = new Date()): Promise<string | null> {
  const last = await prisma.assistantTurn.findFirst({
    where: { tenantId, userId, source },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true },
  });
  if (!last || now.getTime() - last.createdAt.getTime() > CARRY_MS) return null;
  const image = await prisma.assistantImage.findFirst({ where: { tenantId, userId, turnId: last.id }, select: { jpeg: true } });
  return image ? jpegDataUrl(image.jpeg) : null;
}

/** Delete this workspace's kept photos past KEEP_MS. Run by the assistant's cron tick. */
export async function pruneAssistantImages(tenantId: string, now = new Date()): Promise<number> {
  const removed = await basePrisma.assistantImage.deleteMany({ where: { tenantId, createdAt: { lt: new Date(now.getTime() - KEEP_MS) } } });
  return removed.count;
}
