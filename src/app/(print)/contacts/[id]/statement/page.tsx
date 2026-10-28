import { notFound, redirect } from "next/navigation";
import StatementDocument from "@/components/print/StatementDocument";
import StatementUnavailable from "@/components/print/StatementUnavailable";
import { loadContactStatement, statementBillToLines } from "@/lib/accountStatementLoader";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { formatZAR } from "@/lib/format";
import { requireAnyPermission, requireContactReadAccess } from "@/lib/permissions";
import { getRegionalSettings } from "@/lib/settings";
import { statementPrintLayout } from "@/lib/statementDocPrint";
import { billedElsewhereNote } from "@/lib/statementDoc";

export const dynamic = "force-dynamic";

/** A customer's account statement: every invoice billed to them, less deposits and payments. */
export default async function ContactStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ legacy?: string }>;
}) {
  const { id } = await params;
  // This customer, and invoices at all: a statement is a list of invoices.
  const user = await requireContactReadAccess(id);
  await requireAnyPermission("quotes.view_all", "quotes.view_owned");
  // Printed from the document editor — the published Statement, or the published
  // invoice converted — like the invoice itself. This page stays for a workspace
  // with neither, and for the refusals the document route hands back (?legacy=1).
  if (!(await searchParams).legacy && (await statementPrintLayout())) redirect(`/contacts/${id}/statement/document`);
  const regional = await getRegionalSettings();
  const loaded = await loadContactStatement(user, id, (cents) => formatZAR(cents, regional));
  if (loaded.kind === "missing") notFound();
  const backHref = `/contacts/${id}`;
  if (loaded.kind === "partial") return <StatementUnavailable backHref={backHref} backLabel="Back to customer" />;

  const [company, template] = await Promise.all([getCompanyProfile(), getDocTemplate("invoice")]);
  const note = billedElsewhereNote(loaded.billedElsewhere);

  return (
    <StatementDocument
      company={company}
      template={template}
      regional={regional}
      statement={loaded.statement}
      accountName={loaded.accountName}
      billToLines={statementBillToLines(loaded.billTo)}
      statementDate={new Date()}
      backHref={backHref}
      backLabel="Back to customer"
      note={note}
    />
  );
}
