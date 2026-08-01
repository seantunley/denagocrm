import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import { requiredRecordKind } from "@/lib/docbuilder/recordBinding";
import Link from "next/link";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import { DocEditor } from "@/components/doceditor/DocEditor";

export const dynamic = "force-dynamic";

export default async function DocEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("docbuilder.manage");
  const { id } = await params;
  const template = await getBuilderTemplate(id);
  if (!template) notFound();

  const read = readTemplateDocument(template.data, template.name);

  // THIS EDITOR AUTOSAVES. Mounting it means the stored row is one keystroke
  // from being replaced by whatever is on screen, so it may only ever be
  // mounted on content that parsed — never on a fallback.
  //
  // Both failures are refusals, not just "unsupported". An "unreadable" row is
  // not a blank row: `saveBuilderData` used to write `data: unknown` to this
  // column with no validation, and a current-format document with one bad field
  // lands there too. Opening either blank is how the stored content would be
  // lost — the same failure this whole change exists to stop, one status over.
  //
  // A blank document is created explicitly, by createDocEditorTemplate, as a
  // validated DocumentModel. It is never something an editor load falls into.
  if (read.status !== "ok") {
    return (
      <div className="mx-auto max-w-lg space-y-3 p-8">
        <h1 className="text-lg font-semibold text-foreground">
          “{template.name}” can’t be opened in the editor
        </h1>
        <p className="text-sm text-muted-foreground">
          {read.status === "unsupported"
            ? "It was built in the previous document builder and uses a layout this editor can’t represent yet."
            : "Its saved content isn’t in a format this editor recognises."}{" "}
          Nothing has been changed — the template is stored exactly as it was,
          and it is not being opened here because saving over it would lose
          whatever it holds.
        </p>
        <p className="text-sm text-muted-foreground">
          Create a new document to replace it, or send this template name to
          support so the content can be recovered.
        </p>
        <Link href="/settings/documents/builder" className="inline-block text-sm text-primary hover:underline">
          Back to Document Builder
        </Link>
      </div>
    );
  }

  const initialDoc = read.doc;
  const required = requiredRecordKind(template.key);
  const [quotes, jobCards] = await Promise.all([
    required === "jobcard" || required === null
      ? []
      : prisma.quote.findMany({
          where: { supersededAt: null },
          orderBy: { createdAt: "desc" },
          take: 100,
          include: { contact: true },
        }),
    required === "quote" || required === null
      ? []
      : prisma.jobCard.findMany({
          orderBy: { openedAt: "desc" },
          take: 100,
          include: { contact: true, vehicle: true },
        }),
  ]);
  const records = [
    ...quotes.map((quote) => ({
      value: `quote:${quote.id}`,
      label: `Quote Q-${quote.number}${quote.contact ? ` — ${contactName(quote.contact)}` : ""}`,
    })),
    ...jobCards.map((jobCard) => ({
      value: `jobcard:${jobCard.id}`,
      label: `Job #${jobCard.number} — ${contactName(jobCard.contact)} — ${jobCard.vehicle.model}`,
    })),
  ];

  return (
    <DocEditor
      id={template.id}
      initialDoc={initialDoc}
      records={records}
    />
  );
}
