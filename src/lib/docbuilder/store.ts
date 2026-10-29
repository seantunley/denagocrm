import "server-only";
import { prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { TenantScopeError } from "@/lib/tenantGuard";
import { layoutRowVisible, layoutScopeFor, layoutScopeWhere, type LayoutScope } from "@/lib/docbuilder/layoutScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { docKeyEnabled } from "@/lib/docModuleAccess";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import { hasLegacyTokens, inlineLegacyText, type LegacyText } from "@/lib/doceditor/inlineLegacyText";
import { getDocTemplateText } from "@/lib/docTemplateStore";
import {
  STANDARD_TEMPLATE_KEYS,
  STANDARD_TEMPLATE_NAMES,
  standardTemplateFor,
  type StandardDocKey,
} from "@/lib/doceditor/standardTemplates";
import { statementLayoutFromInvoice } from "@/lib/doceditor/statementLayout";
import type { DocumentModel } from "@/lib/doceditor/model";

/**
 * Ensure a valid system builder template exists for every operational document
 * type. Existing data is never overwritten: invalid legacy system rows are
 * preserved for recovery and a new valid template is cloned alongside them.
 */
export async function ensureBuilderSeeded(): Promise<void> {
  for (const key of STANDARD_TEMPLATE_KEYS) {
    // No job card / indemnity / … templates minted for a workspace without the module.
    if (!(await docKeyEnabled(key))) continue;
    try {
      // A Statement is its workspace's own (./layoutScope.ts; review of #925):
      // every query below sees only the acting workspace's statements, so each
      // workspace is seeded its own, from its own invoice, and no workspace's
      // statements are changed by another's. With no workspace to act for (a
      // background render), the statement waits for a request that has one.
      const statementScope = key === "statement" ? await statementSeedScope() : undefined;
      if (statementScope === null) continue;
      const owned = statementScope ? layoutScopeWhere(statementScope) : {};
      const rows = await prisma.docBuilderTemplate.findMany({
        where: { key, deletedAt: null, ...owned },
        select: {
          id: true,
          data: true,
          createdById: true,
          isDefault: true,
        },
      });
      // "Valid" means the app can RENDER it, which now includes the legacy Puck
      // format — otherwise a legacy row is treated as broken and gets a
      // replacement cloned next to it, which is how "Quotation" came to appear
      // twice in the builder list.
      const parsed = rows.map((row) => ({
        ...row,
        valid: readTemplateDocument(row.data).status === "ok",
      }));
      const validSystem = parsed.filter(
        (row) => row.createdById === null && row.valid,
      );

      if (validSystem.length > 0) {
        const currentDefault = parsed.find((row) => row.isDefault);
        const systemDefaultIsBroken =
          !currentDefault ||
          (currentDefault.createdById === null && !currentDefault.valid);
        if (systemDefaultIsBroken) {
          await prisma.docBuilderTemplate.updateMany({
            where: { key, createdById: null, deletedAt: null, ...owned },
            data: { isDefault: false },
          });
          await prisma.docBuilderTemplate.update({
            where: { id: validSystem[0].id },
            data: { isDefault: true },
          });
        }
        continue;
      }

      const seed = await seedLayout(key, statementScope);

      const invalidSystem = parsed.filter(
        (row) => row.createdById === null && !row.valid,
      );
      if (invalidSystem.length > 0) {
        await prisma.docBuilderTemplate.updateMany({
          where: { key, createdById: null, deletedAt: null, ...owned },
          data: { isDefault: false },
        });
      }

      const becomeDefault =
        invalidSystem.some((row) => row.isDefault) ||
        !parsed.some((row) => row.isDefault);
      await prisma.docBuilderTemplate.create({
        data: {
          name: STANDARD_TEMPLATE_NAMES[key],
          key,
          isDefault: becomeDefault,
          ...(seed.tenantId ? { tenantId: seed.tenantId } : {}),
          data: seed.doc as object,
        },
      });
    } catch (error) {
      console.error(`Could not seed builder template "${key}"`, error);
    }
  }
}

/**
 * The acting workspace's scope for seeding its Statement, or null when the
 * request has no workspace to act for — then nobody's invoice is copied.
 */
async function statementSeedScope(): Promise<LayoutScope | null> {
  return actingLayoutScope().catch((error: unknown) => {
    if (error instanceof TenantScopeError) return null;
    throw error;
  });
}

/**
 * A document type's first layout, and the workspace it is stamped with (null:
 * none, as every seeded standard always has been).
 *
 * The statement starts as the ACTING workspace's own published invoice,
 * converted — its header, banking details, payment terms and footer — or, with
 * none published yet, as the standard (History → "Reset draft to the published
 * invoice" rebuilds it once there is one). Either way it is stamped as that
 * workspace's: statements are seeded once per workspace, and an unowned row is
 * nobody's once a second workspace exists (./layoutScope.ts). Every other type
 * gets its standard.
 */
async function seedLayout(key: StandardDocKey, statementScope?: LayoutScope): Promise<{ doc: DocumentModel; tenantId: string | null }> {
  // The workspace's own standard: no vehicle card or EV disclaimer on a
  // non-automotive workspace's quotes.
  const standard = async () => standardTemplateFor(key, { automotive: await isModuleEnabled("automotive") });
  if (key === "statement" && statementScope) {
    const fromInvoice = await statementLayoutFromPublishedInvoice(statementScope);
    return { doc: fromInvoice ?? (await standard()), tenantId: statementScope.tenantId };
  }
  return { doc: await standard(), tenantId: null };
}

/**
 * The ACTING workspace's layout scope (./layoutScope.ts) — the boundary every
 * statement layout lookup puts in its query. The workspace is the one
 * `actingTenantId()` resolves, the same rule the statement's figures use
 * (accountStatementLoader.ts), so the design and the figures can never come from
 * two different workspaces; it refuses (TenantScopeError) when the request has
 * none. `Tenant` is a global model, and two ids answer the only question asked
 * of it: is this workspace the only one?
 */
export async function actingLayoutScope(): Promise<LayoutScope> {
  const tenantId = await actingTenantId();
  const workspaces = await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" }, take: 2 });
  return layoutScopeFor({ tenantId, workspaceIds: workspaces.map((workspace) => workspace.id) });
}

/**
 * The workspace's PUBLISHED invoice layout, converted into a statement
 * (doceditor/statementLayout.ts), or null when it has published none.
 *
 * Only the invoices inside `scope` are candidates — the acting workspace's, plus
 * the ones with no workspace only while it is the only workspace — named in the
 * query, so it holds with tenant enforcement off as well as on: the statement
 * prints this invoice's BANK ACCOUNT. Among them, the invoice is the one that
 * prints — the first readable row, default first, as defaultBuilderTemplateId
 * picks it — read directly rather than through defaultBuilderTemplateId, because
 * that seeds and seeding calls this. Text an older invoice still reads from the
 * old form editor (bank details, payment terms) is written in first, as Publish
 * does, from the same scope: a converted statement would otherwise drop the
 * banking section with the invoice-only field it hangs on.
 */
export async function statementLayoutFromPublishedInvoice(scope: LayoutScope): Promise<DocumentModel | null> {
  if (!(await docKeyEnabled("invoice"))) return null;
  const rows = await prisma.docBuilderTemplate.findMany({
    where: { key: "invoice", deletedAt: null, ...layoutScopeWhere(scope) },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    select: { id: true, data: true, publishedVersion: true },
  });
  const invoice = rows.find((row) => readTemplateDocument(row.data).status === "ok");
  if (!invoice || invoice.publishedVersion == null) return null;
  const live = await getLiveBuilderTemplate(invoice.id);
  if (!live) return null;
  const inlined = await withLegacyTextInlined({ key: "invoice", data: live.data }, scope);
  const read = readTemplateDocument(inlined.data, live.name);
  return read.status === "ok" ? statementLayoutFromInvoice(read.doc) : null;
}

/**
 * Resolve the builder template that should drive an operational document. The
 * explicit default wins, with the most recently updated valid row as fallback.
 *
 * With a `scope`, only that workspace's layouts are candidates
 * (./layoutScope.ts) — the statement passes one, because it prints a bank
 * account. Without one, a type resolves as it always has.
 */
export async function defaultBuilderTemplateId(
  key: string,
  scope?: LayoutScope,
): Promise<string | null> {
  try {
    if (!(await docKeyEnabled(key))) return null;
    await ensureBuilderSeeded();
    const rows = await prisma.docBuilderTemplate.findMany({
      where: { key, deletedAt: null, ...(scope ? layoutScopeWhere(scope) : {}) },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      select: { id: true, data: true },
    });
    return rows.find((row) => readTemplateDocument(row.data).status === "ok")?.id ?? null;
  } catch (error) {
    console.error(`Could not resolve default builder template "${key}"`, error);
    return null;
  }
}

export async function listBuilderTemplates() {
  try {
    // Print layouts only. Customer emails (`email:…`) are documents of the same
    // editor but are not layouts: they have no PDF, and they are listed where
    // they are edited from (Document Studio → emails, Journeys → messages).
    const rows = await prisma.docBuilderTemplate.findMany({
      where: { NOT: { key: { startsWith: "email:" } } },
      orderBy: [{ key: "asc" }, { updatedAt: "desc" }],
    });
    const enabled = await Promise.all(rows.map((row) => docKeyEnabled(row.key)));
    // Statements only for their own workspace, as the door opens them (getBuilderTemplate).
    const scope = rows.some((row) => row.key === "statement") ? await actingLayoutScope().catch(() => null) : null;
    return rows.filter((row, i) => enabled[i] && (row.key !== "statement" || (scope !== null && layoutRowVisible(row.tenantId, scope))));
  } catch {
    return [];
  }
}

export async function getBuilderTemplate(id: string) {
  const record = await prisma.docBuilderTemplate.findUnique({ where: { id } });
  if (!record || record.deletedAt) return null;
  // The one door every by-id read uses (editor, preview, render, export, and the
  // builder actions), so a module-only template opened by id is simply not there.
  if (!(await docKeyEnabled(record.key))) return null;
  // A customer EMAIL layout (`email:…`) exists only for the workspace that OWNS
  // it (review of #806). `isTenantOwner()` proves the caller owns their active
  // workspace, not that this row is in it — and this lookup is by id alone, so
  // an owner of workspace A holding one of B's ids could otherwise open, save,
  // publish, restore and preview B's email. Checked HERE, the one door, so every
  // one of those paths gets it; an email row without a tenant is nobody's.
  if (record.key.startsWith("email:")) {
    const active = await getActiveTenantId().catch(() => null);
    if (!active || record.tenantId !== active) return null;
  }
  // A STATEMENT layout is its workspace's own as well (review of #925): it starts
  // as that workspace's published invoice, banking details and all. The same
  // door and the statement's own rule (./layoutScope.ts), failing closed — a
  // request with no workspace has no statements.
  if (record.key === "statement") {
    const scope = await actingLayoutScope().catch(() => null);
    if (!scope || !layoutRowVisible(record.tenantId, scope)) return null;
  }
  return record;
}

/**
 * An invoice or sales agreement layout that still reads its text (bank
 * details, payment terms, clauses) from the old form editor, with that text
 * written in (inlineLegacyText) — so it is edited in the one editor. READS
 * only: the editor opens this and its save stores it; Publish stores it too
 * (publishBuilderVersion). Until the owner publishes, the live document keeps
 * printing the old text, as it always has.
 *
 * With a `scope`, the old text is that workspace's own (./layoutScope.ts) — a
 * statement's bank details must be; without one it is read as it always has.
 */
export async function withLegacyTextInlined<T extends { key: string; data: unknown }>(template: T, scope?: LayoutScope): Promise<T> {
  if ((template.key !== "invoice" && template.key !== "agreement") || !hasLegacyTokens(template.key, template.data)) return template;
  const old = await getDocTemplateText(template.key, scope);
  const sectionOn = (section: string) => old.sections[section] !== false;
  const legacy: LegacyText =
    template.key === "invoice"
      ? {
          intro: { text: old.intro ?? "", on: true },
          paymentTerms: { text: old.terms ?? "", on: sectionOn("terms") },
          bankingDetails: { text: old.bodyText ?? "", on: sectionOn("banking") },
        }
      : {
          intro: { text: old.intro ?? "", on: true },
          clauses: { text: old.bodyText ?? "", on: sectionOn("clauses") },
        };
  return { ...template, data: inlineLegacyText(template.key, template.data, legacy) };
}

/**
 * The template as customers get it: its PUBLISHED version, not the working draft.
 *
 * The editor autosaves, so rendering `data` put every half-finished edit straight
 * onto quotes, signing envelopes and filed PDFs, and Publish did nothing. Real
 * documents now render the published snapshot. A template never published falls
 * back to its draft, which is exactly what it rendered before this existed, so
 * nothing changes for it until someone presses Publish.
 *
 * Previews of the layout being edited (the editor, ?tpl= in Document Studio, the
 * editor's own export) keep using getBuilderTemplate and the draft.
 */
export async function getLiveBuilderTemplate(id: string) {
  const record = await getBuilderTemplate(id);
  if (!record || record.publishedVersion == null) return record;
  const published = await prisma.docBuilderVersion.findUnique({
    where: { templateId_version: { templateId: id, version: record.publishedVersion } },
    select: { data: true },
  });
  // A missing snapshot would be data damage; render the draft rather than nothing.
  return published ? { ...record, data: published.data } : record;
}

/** Version history for a template, newest first (metadata only — no data blob). */
export async function listBuilderVersions(templateId: string) {
  try {
    return await prisma.docBuilderVersion.findMany({
      where: { templateId },
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        label: true,
        publishedAt: true,
        publishedBy: true,
      },
    });
  } catch {
    return [];
  }
}
