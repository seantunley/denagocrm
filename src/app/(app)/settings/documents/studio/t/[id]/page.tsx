import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Rocket } from "lucide-react";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { MERGE_FIELDS } from "@/lib/mergeFields";
import { formatDateTime } from "@/lib/format";
import StudioEditor from "@/components/StudioEditor";
import { saveStudioTemplate, publishStudioTemplate } from "@/app/actions/studio";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function StudioTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("document_templates.manage");
  const { id } = await params;
  const [tpl, clauses] = await Promise.all([
    prisma.customDocTemplate.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: "desc" }, take: 5 } },
    }),
    prisma.reusableBlock.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!tpl) notFound();
  const latest = tpl.versions[0];

  async function save(data: { title: string; content: unknown }) {
    "use server";
    return saveStudioTemplate(id, { name: data.title, content: data.content });
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
          Template — insert merge fields where customer data should appear; publishing freezes a
          version that new documents are generated from.
          {latest
            ? ` Currently published: v${latest.version} (${formatDateTime(latest.publishedAt)}).`
            : " Not published yet — documents will use the live draft."}
        </p>
      </div>

      <StudioEditor
        initialTitle={tpl.name}
        initialContent={tpl.draftJson}
        fields={MERGE_FIELDS}
        clauses={clauses.map((clause) => ({
          id: clause.id,
          name: clause.name,
          category: clause.category,
          contentJson: clause.contentJson,
        }))}
        onSave={save}
        headerRight={
          <form action={publishStudioTemplate.bind(null, id)}>
            <Button size="sm" type="submit" title="Freeze the current draft as the next version">
              <Rocket className="size-4" />
              Publish {latest ? `v${latest.version + 1}` : "v1"}
            </Button>
          </form>
        }
      />
    </div>
  );
}
