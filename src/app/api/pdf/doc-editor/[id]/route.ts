import { requireApiOwner, apiAuthErrorResponse } from "@/lib/auth";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import {
  bindingParams,
  parseBuilderRecord,
  recordMatchesTemplate,
} from "@/lib/docbuilder/recordBinding";
import { generateDocEditorPdf } from "@/lib/doceditor/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireApiOwner();
  } catch (error) {
    const response = apiAuthErrorResponse(error);
    if (response) return response;
    throw error;
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
