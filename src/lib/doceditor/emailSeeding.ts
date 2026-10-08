import "server-only";
import { basePrisma, prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { SIGNING_EMAILS, parseStoredSigningTemplate } from "../signing/emailTemplates";
import { defaultEmailBody, defaultEmailFrame, EMAIL_FRAME_KEY, EMAIL_KINDS, emailBodyKey } from "./emailDefaults";

export type EmailTemplateRow = { id: string; key: string; publishedVersion: number | null };

/** createdAt and updatedAt are stamped separately on create; within this of each other, the row was never saved again. */
const UNTOUCHED_MS = 5000;

/**
 * The acting workspace's email documents — the frame and one body per email —
 * creating any that are missing, from the wording it sends today (its own edited
 * copy when it has one). Created as DRAFTS: nothing a customer receives changes
 * until the owner publishes the frame.
 *
 * Creation runs under a per-workspace advisory lock inside one transaction, and
 * re-reads what exists under that lock, so two pages opening at once cannot
 * create the same email twice.
 */
export async function ensureEmailTemplates(): Promise<Map<string, EmailTemplateRow>> {
  const tenantId = await getActiveTenantId();
  const keys = [EMAIL_FRAME_KEY, ...EMAIL_KINDS.map(emailBodyKey)];
  if (!tenantId) return new Map();
  const query = {
    where: { tenantId, key: { in: keys }, deletedAt: null },
    orderBy: [{ isDefault: "desc" as const }, { updatedAt: "desc" as const }],
    select: { id: true, key: true, publishedVersion: true },
  };
  const index = (rows: EmailTemplateRow[]) => {
    const map = new Map<string, EmailTemplateRow>();
    for (const row of rows) if (!map.has(row.key)) map.set(row.key, row);
    return map;
  };

  // The guarded client: the acting workspace's rows only, whatever `query` says.
  let found = index(await prisma.docBuilderTemplate.findMany(query));

  // Today's wording, read by explicit tenant — the same keys the send path reads.
  const saved = await basePrisma.appSetting.findMany({
    where: { tenantId, key: { in: EMAIL_KINDS.map((k) => SIGNING_EMAILS[k].settingKey) } },
    select: { key: true, value: true },
  });
  const standardFor = (key: string) => {
    const kind = EMAIL_KINDS.find((k) => emailBodyKey(k) === key);
    return kind
      ? defaultEmailBody(kind, parseStoredSigningTemplate(saved.find((s) => s.key === SIGNING_EMAILS[kind].settingKey)?.value, kind))
      : defaultEmailFrame();
  };

  // A draft nobody has touched — never published, never saved since it was
  // created — is brought up to the current standard, once: when the standard
  // wording is rewritten, a workspace that has not started on an email should
  // open the new wording, not the copy made the day the editor arrived. The
  // write itself marks the row touched (updatedAt moves), so it never repeats,
  // and it is conditional on the row still being exactly as read: an edit that
  // lands in between wins. Nothing here is live — these are drafts.
  const untouched = (
    await prisma.docBuilderTemplate.findMany({
      where: { tenantId, key: { in: keys }, deletedAt: null, publishedVersion: null },
      select: { id: true, key: true, createdAt: true, updatedAt: true },
    })
  ).filter((row) => row.updatedAt.getTime() - row.createdAt.getTime() < UNTOUCHED_MS);
  for (const row of untouched) {
    const data = standardFor(row.key);
    await prisma.docBuilderTemplate.updateMany({
      where: { id: row.id, tenantId, updatedAt: row.updatedAt, publishedVersion: null },
      data: { name: data.title, data: data as object },
    });
  }

  if (keys.every((k) => found.has(k))) return found;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-templates:${tenantId}`}))`;
    found = index(await tx.docBuilderTemplate.findMany(query));
    for (const key of keys) {
      if (found.has(key)) continue;
      const data = standardFor(key);
      const row = await tx.docBuilderTemplate.create({
        data: { tenantId, key, name: data.title, isDefault: true, data: data as object },
        select: { id: true, key: true, publishedVersion: true },
      });
      found.set(key, row);
    }
  });
  return found;
}
