import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, FileDown, Lock } from "lucide-react";
import { prisma } from "@/lib/db";
import { listStudioClauses } from "@/lib/docTemplateStore";
import {
  canAccessContact,
  canAccessLead,
  canAccessQuote,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { MERGE_FIELDS } from "@/lib/mergeFields";
import { contactName, formatDateTime } from "@/lib/format";
import StudioEditor from "@/components/StudioEditor";
import StudioFinalize from "@/components/StudioFinalize";
import { saveDocInstance } from "@/app/actions/studio";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function StudioDocPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAnyPermission("documents.view_all", "documents.view_owned", "documents.manage");
  const { id } = await params;
  const [doc, clauses] = await Promise.all([
    prisma.docInstance.findUnique({ where: { id }, include: { template: true } }),
    listStudioClauses(),
  ]);
  if (!doc || doc.deletedAt) notFound();
  // Made in the document editor: its content is not BlockNote, so it opens there.
  if (doc.docModelJson != null) redirect(`/doc-editor/document/${id}`);
  const allowed =
    (!doc.contactId || await canAccessContact(user, doc.contactId)) &&
    (!doc.leadId || await canAccessLead(user, doc.leadId)) &&
    (!doc.quoteId || await canAccessQuote(user, doc.quoteId));
  if (!allowed) notFound();
  const canManage = await hasPermission(user, "documents.manage");
  const contact = doc.contactId
    ? await prisma.contact.findUnique({ where: { id: doc.contactId } })
    : null;
  const final = doc.status === "final";

  async function save(data: { title: string; content: unknown }) {
    "use server";
    return saveDocInstance(id, data);
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/documents"
          className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Documents
        </Link>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase">Studio (legacy)</span>
          {final ? (
            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300">
              <Lock className="size-3" />
              Finalised {doc.finalizedAt ? formatDateTime(doc.finalizedAt) : ""} — read-only
            </span>
          ) : canManage ? (
            <span>Draft document — merge data was resolved when it was created.</span>
          ) : (
            <span>Draft document — read-only because your role cannot edit documents.</span>
          )}
          {doc.template && <span>· from “{doc.template.name}”</span>}
          {contact && (
            <span>
              · for{" "}
              <Link href={`/contacts/${contact.id}`} className="text-primary hover:underline">
                {contactName(contact)}
              </Link>
            </span>
          )}
        </p>
      </div>

      <StudioEditor
        initialTitle={doc.title}
        initialContent={doc.contentJson}
        fields={MERGE_FIELDS}
        clauses={clauses.map((clause) => ({
          id: clause.id,
          name: clause.name,
          category: clause.category,
          contentJson: clause.contentJson,
        }))}
        readOnly={final || !canManage}
        onSave={save}
        headerRight={
          final ? (
            doc.pdfDocId ? (
              <Button asChild size="sm" variant="outline">
                <a href={`/api/files/${doc.pdfDocId}`} target="_blank" rel="noreferrer">
                  <FileDown className="size-4" />
                  Open PDF
                </a>
              </Button>
            ) : null
          ) : canManage ? (
            <StudioFinalize docId={doc.id} />
          ) : null
        }
      />
    </div>
  );
}
