import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { MERGE_FIELDS } from "@/lib/mergeFields";
import StudioEditor from "@/components/StudioEditor";
import { saveReusableBlock } from "@/app/actions/studio";

export const dynamic = "force-dynamic";

export default async function StudioClausePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const clause = await prisma.reusableBlock.findUnique({ where: { id } });
  if (!clause) notFound();

  async function save(data: { title: string; content: unknown }) {
    "use server";
    return saveReusableBlock(id, data);
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/settings/documents?tab=studio"
          className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Document Studio
        </Link>
        <p className="text-sm text-muted-foreground">
          Reusable clause — insert it into any template or document. It's copied in at insert
          time, so editing this clause never changes existing documents.
        </p>
      </div>

      <StudioEditor
        initialTitle={clause.name}
        initialContent={clause.contentJson}
        fields={MERGE_FIELDS}
        clauses={[]}
        onSave={save}
      />
    </div>
  );
}
