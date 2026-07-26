import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import { requiredRecordKind } from "@/lib/docbuilder/recordBinding";
import { parseDocument } from "@/lib/doceditor/model";
import { blankDocument } from "@/lib/doceditor/factory";
import { DocEditor } from "@/components/doceditor/DocEditor";

export const dynamic = "force-dynamic";

export default async function DocEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOwner();
  const { id } = await params;
  const template = await getBuilderTemplate(id);
  if (!template) notFound();

  const initialDoc =
    parseDocument(template.data) ?? blankDocument(template.name);
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
