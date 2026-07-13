import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getPdfmeTemplate } from "@/lib/pdfmeStore";
import DesignerEditor from "./DesignerEditor";

export const dynamic = "force-dynamic";

export default async function DesignerPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const tpl = await getPdfmeTemplate(id);
  if (!tpl) notFound();

  return (
    <DesignerEditor
      id={tpl.id}
      name={tpl.name}
      initialSchema={tpl.schema}
      sample={tpl.sample}
    />
  );
}
