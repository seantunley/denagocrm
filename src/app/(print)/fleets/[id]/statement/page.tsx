import { notFound } from "next/navigation";
import StatementDocument from "@/components/print/StatementDocument";
import StatementUnavailable from "@/components/print/StatementUnavailable";
import { loadFleetStatement, statementBillToLines } from "@/lib/accountStatementLoader";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { formatZAR } from "@/lib/format";
import { requireAnyPermission, requireRoute } from "@/lib/permissions";
import { getRegionalSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** A fleet / business account's statement: every invoice billed to the account, less deposits and payments. */
export default async function FleetStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The fleet screens' own guard (routeAccess.ts), then invoices at all.
  const user = await requireRoute("/fleets");
  await requireAnyPermission("quotes.view_all", "quotes.view_owned");
  const regional = await getRegionalSettings();
  const loaded = await loadFleetStatement(user, id, (cents) => formatZAR(cents, regional));
  if (loaded.kind === "missing") notFound();
  const backHref = `/fleets/${id}`;
  if (loaded.kind === "partial") return <StatementUnavailable backHref={backHref} backLabel="Back to fleet" />;

  const [company, template] = await Promise.all([getCompanyProfile(), getDocTemplate("invoice")]);
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
      backLabel="Back to fleet"
    />
  );
}
