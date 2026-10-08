import "server-only";
import { basePrisma, prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { SIGNING_EMAILS, parseStoredSigningTemplate, type SigningEmailKind } from "../signing/emailTemplates";
import { defaultEmailBody, defaultEmailFrame, EMAIL_FRAME_KEY, EMAIL_KINDS, emailBodyKey, isUntouchedEmailSeed } from "./emailDefaults";

export type EmailTemplateRow = { id: string; key: string; publishedVersion: number | null };

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
  const kindOf = (key: string) => EMAIL_KINDS.find((k) => emailBodyKey(k) === key);
  const storedFor = (kind: SigningEmailKind) =>
    parseStoredSigningTemplate(saved.find((s) => s.key === SIGNING_EMAILS[kind].settingKey)?.value, kind);
  const standardFor = (key: string) => {
    const kind = kindOf(key);
    return kind ? defaultEmailBody(kind, storedFor(kind)) : defaultEmailFrame();
  };

  // A draft nobody has changed is brought up to the current standard wording:
  // when the standard is rewritten, a workspace that has not started on an
  // email should open the new wording, not the copy made the day the editor
  // arrived. "Nobody has changed" is decided by CONTENT — the draft is exactly
  // what seeding from a replaced standard produced (isUntouchedEmailSeed) — never
  // by timestamps: the editor autosaves about a second after a keystroke, so no
  // window after creation is safe to call unedited (review of #807). Never a
  // published email. The write is conditional on the row being exactly as read,
  // so a save landing in between wins; afterwards the draft is the current
  // standard, which matches no replaced seed, so this does not repeat.
  // Nothing here is live — these are drafts.
  const drafts = await prisma.docBuilderTemplate.findMany({
    where: { tenantId, key: { in: EMAIL_KINDS.map(emailBodyKey) }, deletedAt: null, publishedVersion: null },
    select: { id: true, key: true, data: true, updatedAt: true },
  });
  for (const row of drafts) {
    const kind = kindOf(row.key);
    if (!kind || !isUntouchedEmailSeed(kind, row.data, storedFor(kind))) continue;
    await prisma.docBuilderTemplate.updateMany({
      where: { id: row.id, tenantId, updatedAt: row.updatedAt, publishedVersion: null },
      data: { data: defaultEmailBody(kind, storedFor(kind)) as object },
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
