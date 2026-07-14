import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import { parseDocument } from "@/lib/doceditor/model";
import { blankDocument } from "@/lib/doceditor/factory";
import { DocEditor } from "@/components/doceditor/DocEditor";

export const dynamic = "force-dynamic";

/** Full-screen PandaDoc-style document editor. */
export default async function DocEditorPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const tpl = await getBuilderTemplate(id);
  if (!tpl) notFound();

  // New-model doc, or seed a blank one for legacy/empty templates (persists on first save).
  const initialDoc = parseDocument(tpl.data) ?? blankDocument(tpl.name);

  const quotes = await prisma.quote.findMany({
    where: { supersededAt: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { contact: true },
  });
  const quoteOpts = quotes.map((q) => ({ id: q.id, label: `Q-${q.number}${q.contact ? ` — ${contactName(q.contact)}` : ""}` }));

  return <DocEditor id={tpl.id} initialDoc={initialDoc} quotes={quoteOpts} />;
}
