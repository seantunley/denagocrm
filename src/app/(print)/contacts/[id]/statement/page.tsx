import { notFound } from "next/navigation";
import StatementDocument from "@/components/print/StatementDocument";
import StatementUnavailable from "@/components/print/StatementUnavailable";
import { loadContactStatement, statementBillToLines } from "@/lib/accountStatementLoader";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { formatZAR } from "@/lib/format";
import { requireAnyPermission, requireContactReadAccess } from "@/lib/permissions";
import { getRegionalSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** A customer's account statement: every invoice billed to them, less deposits and payments. */
export default async function ContactStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // This customer, and invoices at all: a statement is a list of invoices.
  const user = await requireContactReadAccess(id);
  await requireAnyPermission("quotes.view_all", "quotes.view_owned");
  const regional = await getRegionalSettings();
  const loaded = await loadContactStatement(user, id, (cents) => formatZAR(cents, regional));
  if (loaded.kind === "missing") notFound();
  const backHref = `/contacts/${id}`;
  if (loaded.kind === "partial") return <StatementUnavailable backHref={backHref} backLabel="Back to customer" />;

  const [company, template] = await Promise.all([getCompanyProfile(), getDocTemplate("invoice")]);
  const note = loaded.billedElsewhere.length
    ? `Not on this statement: ${loaded.billedElsewhere
        .map((entry) => `${entry.count} invoice${entry.count === 1 ? "" : "s"} billed to ${entry.fleetName}`)
        .join(", ")} — print that account's statement from its fleet page.`
    : null;

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
