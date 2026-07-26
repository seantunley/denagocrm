import { getCurrentUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import {
  bindingParams,
  parseBuilderRecord,
  recordMatchesTemplate,
} from "@/lib/docbuilder/recordBinding";
import {
  generateDocEditorExport,
  type ExportFormat,
} from "@/lib/doceditor/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORMATS: ExportFormat[] = ["html", "email", "doc"];

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
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

  const requested = url.searchParams.get("format");
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
}
