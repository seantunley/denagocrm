import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";
import { formatDateTime } from "@/lib/format";
import { parseDocument } from "@/lib/doceditor/model";
import { canAccessDocumentLinks } from "@/lib/doceditor/instanceAccess";
import { customDocumentEditable } from "@/lib/doceditor/customDocument";
import { DocEditor } from "@/components/doceditor/DocEditor";
import { DocEditorEnvProvider } from "@/components/doceditor/EditorContext";
import { getCompanyProfile } from "@/lib/companyProfile";
import { documentLogo } from "@/lib/doceditor/renderGlobals";

export const dynamic = "force-dynamic";

/**
 * A custom document in the one document editor. Same audience and record rule
 * as the Studio document page it replaces: document view permissions to open,
 * documents.manage to edit, and access to every record it is linked to.
 */
export default async function CustomDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAnyPermission("documents.view_all", "documents.view_owned", "documents.manage");
  const { id } = await params;
  const row = await prisma.docInstance.findUnique({ where: { id } });
  if (!row || row.deletedAt || !(await canAccessDocumentLinks(user, row))) notFound();
  // A legacy Studio (BlockNote) document — none exist; the Studio editor is
  // gone (one editor, 2026-10-07). Its filed PDF stays in the repository.
  if (row.docModelJson == null) redirect("/document-studio");

  const doc = parseDocument(row.docModelJson);
  const editable = customDocumentEditable(row) && (await hasPermission(user, "documents.manage"));

  // The editor autosaves, so it is only mounted on a draft the caller may edit
  // and whose content parsed — never on a fallback it would save over.
  if (editable && doc) {
    // The canvas shows the same embedded logo the finalised PDF will carry.
    const company = await getCompanyProfile();
    const logoSrc = (await documentLogo(company.logoUrl, row.tenantId)) ?? "";
    return (
      <DocEditorEnvProvider value={{ templateId: null, logoSrc, companyName: company.name }}>
        <DocEditor id={row.id} initialDoc={doc} records={[]} mode="document" />
      </DocEditorEnvProvider>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-3 p-8">
      <h1 className="text-lg font-semibold text-foreground">{row.title}</h1>
      <p className="text-sm text-muted-foreground">
        {row.status === "final"
          ? `Finalised${row.finalizedAt ? ` ${formatDateTime(row.finalizedAt)}` : ""}. The filed PDF is the record of this document, so it can no longer be edited.`
          : !doc
            ? "This document's content isn't in a format the editor recognises. Nothing has been changed."
            : "Draft. Your role can view documents but not edit them."}
      </p>
      <div className="flex gap-3 text-sm">
        {row.pdfDocId && (
          <a href={`/api/files/${row.pdfDocId}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            Open filed PDF
          </a>
        )}
        {doc && row.status !== "final" && (
          <a href={`/api/pdf/doc-instance/${row.id}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            Preview
          </a>
        )}
        <Link href="/document-studio" className="text-muted-foreground hover:text-foreground">
          Back to Document Studio
        </Link>
      </div>
    </div>
  );
}
