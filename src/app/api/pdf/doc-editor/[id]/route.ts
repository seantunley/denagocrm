import { getCurrentUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import {
  bindingParams,
  parseBuilderRecord,
  recordMatchesTemplate,
} from "@/lib/docbuilder/recordBinding";
import { RECORD_UNAVAILABLE, canAccessBuilderRecord } from "@/lib/docbuilder/recordAccess";
import { generateDocEditorPdf } from "@/lib/doceditor/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!(await hasAnyPermission(user, "docbuilder.view", "docbuilder.manage"))) {
    return new Response("Forbidden", { status: 403 });
  }

  const { id } = await context.params;
  const template = await getBuilderTemplate(id);
  if (!template) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const supplied = url.searchParams.get("record");
  const record = supplied
    ? parseBuilderRecord(supplied)
    : url.searchParams.get("job")
      ? { kind: "jobcard" as const, id: url.searchParams.get("job")! }
      : url.searchParams.get("quote")
        ? { kind: "quote" as const, id: url.searchParams.get("quote")! }
        : null;
  if (supplied && !record) {
    return new Response("Invalid record", { status: 400 });
  }
  if (record && !recordMatchesTemplate(template.key, record.kind)) {
    return new Response("Record type does not match this template", {
      status: 400,
    });
  }
  // docbuilder.view above answers "may this person work with templates". It says
  // nothing about the quote or job card whose id just arrived on the query string,
  // and this endpoint renders that record's pricing, line items and customer block
  // into a PDF. 404, not 403, and the same body as a missing template: a distinct
  // refusal would confirm the record exists to someone enumerating ids.
  if (record && !(await canAccessBuilderRecord(user, record))) {
    return new Response(RECORD_UNAVAILABLE, { status: 404 });
  }

  const result = await generateDocEditorPdf({
    templateId: id,
    ...bindingParams(record ? `${record.kind}:${record.id}` : null),
  });
  if (!result) {
    return new Response("Not found or empty document", { status: 404 });
  }
  return new Response(new Uint8Array(result.buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${result.title.replace(/[^a-z0-9]+/gi, "-")}.pdf"`,
    },
  });
}
