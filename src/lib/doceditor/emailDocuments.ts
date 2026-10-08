import "server-only";
import { basePrisma } from "@/lib/db";
import { parseDocument, type DocumentModel } from "./model";
import { EMAIL_FRAME_KEY, emailBodyKey } from "./emailDefaults";
import type { SigningEmailKind } from "../signing/emailTemplates";

/**
 * The PUBLISHED email frame and one message's PUBLISHED body for a workspace —
 * what customers get. A draft (seeded or autosaved, never published) is not
 * here: nobody approved it, so the message keeps sending as it does until
 * someone presses Publish (the same rule as documents, docbuilder/published.ts).
 *
 * Read by EXPLICIT tenant on basePrisma, never ambient scope: emails go out
 * from cron, the job worker and public signing pages as often as from a
 * signed-in action. Never throws — a failed read is "not published".
 */
export async function publishedEmailDocs(
  tenantId: string,
  kind: SigningEmailKind,
): Promise<{ frame: DocumentModel | null; body: DocumentModel | null }> {
  try {
    const templates = await basePrisma.docBuilderTemplate.findMany({
      where: { tenantId, key: { in: [EMAIL_FRAME_KEY, emailBodyKey(kind)] }, deletedAt: null, publishedVersion: { not: null } },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      select: { id: true, key: true, publishedVersion: true },
    });
    const load = async (key: string) => {
      const template = templates.find((t) => t.key === key);
      if (!template || template.publishedVersion == null) return null;
      const version = await basePrisma.docBuilderVersion.findUnique({
        where: { templateId_version: { templateId: template.id, version: template.publishedVersion } },
        select: { data: true, tenantId: true },
      });
      // The version belongs to the template's workspace — never another's.
      return version && (version.tenantId === null || version.tenantId === tenantId) ? parseDocument(version.data) : null;
    };
    const [frame, body] = await Promise.all([load(EMAIL_FRAME_KEY), load(emailBodyKey(kind))]);
    return { frame, body };
  } catch {
    return { frame: null, body: null };
  }
}
