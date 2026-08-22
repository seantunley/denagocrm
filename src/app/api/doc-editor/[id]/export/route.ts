import { getCurrentUser } from "@/lib/auth";
import { withActingStaffScope } from "@/lib/actingScope";
import { hasAnyPermission } from "@/lib/permissions";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import {
  bindingParams,
  parseBuilderRecord,
  recordMatchesTemplate,
} from "@/lib/docbuilder/recordBinding";
import { RECORD_UNAVAILABLE, canAccessBuilderRecord } from "@/lib/docbuilder/recordAccess";
import {
  generateDocEditorExport,
  type ExportFormat,
} from "@/lib/doceditor/generate";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import { buildPortableDocument } from "@/lib/doceditor/portable";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORMATS: ExportFormat[] = ["html", "email", "doc"];

/**
 * Bound with withActingStaffScope because this is a ROUTE HANDLER: no layout
 * runs above it, so nothing establishes the acting workspace the way (app)'s
 * layout does for an ordinary page.
 *
 * The document build below reaches lib/doceditor/generate.ts, which resolves the
 * quote's fleet account and therefore reads the tenant scope SYNCHRONOUSLY
 * through activeTenantPredicate. Under TENANT_ENFORCEMENT=enforce a sync read
 * with no scope THROWS rather than returning an empty predicate, and nothing
 * here catches it - a bare 500, with the error filed against no workspace and so
 * invisible in the tenant's System Log.
 *
 * Found by tests/apiRouteTenantScope.test.ts alongside the quote print route that
 * actually broke in production; these two had the same defect and had simply not
 * been exercised on a fleet-billed document yet.
 *
 * Never widens: an already-bound scope wins, and an unresolvable session runs
 * bare so the access checks below still fail closed.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withActingStaffScope(async () => {
  // Match the docbuilder PDF route: granular docbuilder access, not owner-only, so
  // this export sibling isn't stricter than the editor/preview it accompanies.
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!(await hasAnyPermission(user, "docbuilder.view", "docbuilder.manage"))) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;
  const template = await getBuilderTemplate(id);
  if (!template) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const value = url.searchParams.get("record");
  const record = value
    ? parseBuilderRecord(value)
    : url.searchParams.get("job")
      ? { kind: "jobcard" as const, id: url.searchParams.get("job")! }
      : url.searchParams.get("quote")
        ? { kind: "quote" as const, id: url.searchParams.get("quote")! }
        : null;
  if (value && !record) return new Response("Invalid record", { status: 400 });
  if (record && !recordMatchesTemplate(template.key, record.kind)) {
    return new Response("Record type does not match this template", {
      status: 400,
    });
  }
  // Same missing check as the PDF sibling, and this one hands the quote over as
  // html / email / doc — copy-pasteable text rather than a rendered page. Placed
  // ABOVE the `format=json` branch even though that branch ignores the binding, so
  // the record check cannot be skipped by choosing a format.
  if (record && !(await canAccessBuilderRecord(user, record))) {
    return new Response(RECORD_UNAVAILABLE, { status: 404 });
  }

  const requested = url.searchParams.get("format");

  // The portable format is the template itself, not a render of it — so it
  // deliberately ignores the record binding above and never goes through the
  // HTML pipeline. It is the only export another tenant can import.
  if (requested === "json") {
    const read = readTemplateDocument(template.data, template.name);
    if (read.status !== "ok") {
      return new Response(
        "This document was built in the previous builder, so there is no model to export. Recreate it here first.",
        { status: 409 },
      );
    }
    const payload = buildPortableDocument({
      name: template.name,
      key: template.key,
      document: read.doc,
      exportedAt: new Date().toISOString(),
    });
    const name = `${template.name.replace(/[^a-z0-9]+/gi, "-")}.denagodoc.json`;
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  }

  const format: ExportFormat = FORMATS.includes(requested as ExportFormat)
    ? (requested as ExportFormat)
    : "html";
  const result = await generateDocEditorExport({
    templateId: id,
    ...bindingParams(record ? `${record.kind}:${record.id}` : null),
    format,
  });
  if (!result) return new Response("Not found", { status: 404 });
  const filename = `${result.title.replace(/[^a-z0-9]+/gi, "-")}.${result.ext}`;
  return new Response(result.content, {
    headers: {
      "Content-Type": result.mime,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
  });
}
